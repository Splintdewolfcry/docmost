import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { MultipartFile } from '@fastify/multipart';
import * as path from 'path';
import {
  htmlToJson,
  jsonToText,
  tiptapExtensions,
} from '../../../collaboration/collaboration.util';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import {
  generateSlugId,
  sanitizeFileName,
  createByteCountingStream,
} from '../../../common/helpers';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { TiptapTransformer } from '@hocuspocus/transformer';
import * as Y from 'yjs';
import { markdownToHtml } from '@docmost/editor-ext';
import {
  FileTaskStatus,
  FileTaskType,
  getFileTaskFolderPath,
} from '../utils/file.utils';
import { v7 as uuid7 } from 'uuid';
import { StorageService } from '../../storage/storage.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueJob, QueueName } from '../../queue/constants';
import { ModuleRef } from '@nestjs/core';
import { load } from 'cheerio';
import { normalizeImportHtml } from '../utils/import-formatter';
import { getMimeType } from '../../../common/helpers';
import {
  getAttachmentFolderPath,
} from '../../../core/attachment/attachment.utils';
import { AttachmentType } from '../../../core/attachment/attachment.constants';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    private readonly pageRepo: PageRepo,
    private readonly storageService: StorageService,
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.FILE_TASK_QUEUE)
    private readonly fileTaskQueue: Queue,
    private moduleRef: ModuleRef,
  ) {}

  async importPage(
    filePromise: Promise<MultipartFile>,
    userId: string,
    spaceId: string,
    workspaceId: string,
  ) {
    const file = await filePromise;
    const fileBuffer = await file.toBuffer();
    const fileExtension = path.extname(file.filename).toLowerCase();
    const fileName = sanitizeFileName(
      path.basename(file.filename, fileExtension),
    );
    const fileContent = fileBuffer.toString();

    let prosemirrorState = null;
    let createdPage = null;

    // For DOCX, we need the page ID upfront so images can reference it
    const pageId =
      fileExtension === '.docx' || fileExtension === '.pdf'
        ? uuid7()
        : undefined;

    try {
      if (fileExtension.endsWith('.md')) {
        prosemirrorState = await this.processMarkdown(fileContent);
      } else if (fileExtension.endsWith('.html')) {
        prosemirrorState = await this.processHTML(fileContent);
      } else if (fileExtension.endsWith('.docx')) {
        prosemirrorState = await this.processDocx(
          fileBuffer,
          workspaceId,
          spaceId,
          pageId,
          userId,
        );
      } else if (fileExtension.endsWith('.pdf')) {
        prosemirrorState = await this.processPdf(
          fileBuffer,
          workspaceId,
          spaceId,
          pageId,
          userId,
          `${fileName}${fileExtension}`,
        );
      }
    } catch (err) {
      const message = 'Error processing file content';
      this.logger.error(message, err);
      throw new BadRequestException(message);
    }

    if (!prosemirrorState) {
      const message = 'Failed to create ProseMirror state';
      this.logger.error(message);
      throw new BadRequestException(message);
    }

    const { title, prosemirrorJson } = this.extractTitleAndRemoveHeading(
      prosemirrorState,
      { anyHeadingLevel: true },
    );

    const pageTitle = title || fileName;

    if (prosemirrorJson) {
      try {
        const pagePosition = await this.getNewPagePosition(spaceId);

        createdPage = await this.pageRepo.insertPage({
          ...(pageId ? { id: pageId } : {}),
          slugId: generateSlugId(),
          title: pageTitle,
          content: prosemirrorJson,
          textContent: jsonToText(prosemirrorJson),
          ydoc: await this.createYdoc(prosemirrorJson),
          position: pagePosition,
          spaceId: spaceId,
          creatorId: userId,
          workspaceId: workspaceId,
          lastUpdatedById: userId,
        });

        this.logger.debug(
          `Successfully imported "${title}${fileExtension}. ID: ${createdPage.id} - SlugId: ${createdPage.slugId}"`,
        );
      } catch (err) {
        const message = 'Failed to create imported page';
        this.logger.error(message, err);
        throw new BadRequestException(message);
      }
    }

    return createdPage;
  }

  async processMarkdown(markdownInput: string): Promise<any> {
    try {
      const html = await markdownToHtml(markdownInput);
      return this.processHTML(html);
    } catch (err) {
      throw err;
    }
  }

  async processHTML(htmlInput: string): Promise<any> {
    try {
      const $ = load(htmlInput);
      normalizeImportHtml($, $.root());
      return htmlToJson($.html() || '');
    } catch (err) {
      throw err;
    }
  }

  async processDocx(
    fileBuffer: Buffer,
    workspaceId: string,
    spaceId: string,
    pageId: string,
    userId: string,
  ): Promise<any> {
    let DocxImportModule: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      DocxImportModule = require('./../../../ee/document-import/docx-import.service');
    } catch (err) {
      this.logger.error(
        'DOCX import requested but EE module not bundled in this build',
      );
      throw new BadRequestException(
        'This feature requires a valid enterprise license.',
      );
    }

    const docxImportService = this.moduleRef.get(
      DocxImportModule.DocxImportService,
      { strict: false },
    );

    const html = await docxImportService.convertDocxToHtml(
      fileBuffer,
      workspaceId,
      spaceId,
      pageId,
      userId,
    );

    return this.processHTML(html);
  }

  async processPdf(
    fileBuffer: Buffer,
    workspaceId: string,
    spaceId: string,
    pageId: string,
    userId: string,
    fileNameWithExt?: string,
  ): Promise<any> {
    let pdfInspector: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      pdfInspector = require('@docmost/pdf-inspector');
    } catch (err) {
      this.logger.error(
        'PDF import requested but @docmost/pdf-inspector is not installed',
        err,
      );
      throw new BadRequestException(
        'PDF import is not available. @docmost/pdf-inspector is not installed.',
      );
    }

    // Page count drives the page-number anchors used for bidirectional links
    let pageCount = 0;
    try {
      pageCount = pdfInspector.classifyPdf?.(fileBuffer)?.pageCount ?? 0;
    } catch (err) {
      this.logger.warn('PDF classifyPdf failed', err as Error);
    }

    // Per-page markdown is the most reliable text source: it returns text even
    // for pages processPdfWithImages classifies as needing OCR (ImageBased/Mixed).
    let pageEntries: Array<{
      page: number;
      markdown: string;
      needsOcr: boolean;
    }> = [];
    try {
      pageEntries = pdfInspector.extractPagesMarkdown?.(fileBuffer)?.pages ?? [];
    } catch (err) {
      this.logger.warn('PDF extractPagesMarkdown failed', err as Error);
    }

    const hasPageText = pageEntries.some(
      (entry) => (entry.markdown ?? '').trim().length > 0,
    );

    let fullResult: any = null;
    let fallbackText = '';
    if (!hasPageText) {
      try {
        fullResult = pdfInspector.processPdfWithImages(fileBuffer);
      } catch (err) {
        this.logger.warn('PDF processPdfWithImages failed', err as Error);
      }
      if (!fullResult?.markdown?.trim()) {
        try {
          fallbackText = pdfInspector.extractText?.(fileBuffer) ?? '';
        } catch (err) {
          this.logger.warn('PDF extractText fallback failed', err as Error);
        }
      }
    }

    if (!pageCount) {
      pageCount = Math.max(
        fullResult?.pageCount ?? 0,
        pageEntries.length ?? 0,
      );
    }

    const hasFullText = !!fullResult?.markdown?.trim();
    const hasText = hasPageText || hasFullText || !!fallbackText.trim();

    // Always preserve the original file: it powers the embedded viewer, the
    // attachments tab and the #page=N deep links used by page anchors.
    const original = await this.storePdfOriginal(
      fileBuffer,
      workspaceId,
      spaceId,
      pageId,
      userId,
      fileNameWithExt,
    );

    if (!hasText) {
      // Scanned PDF with no OCR-ed text: leave content as-is, embed the
      // viewer and expose page-number links for bidirectional referencing.
      return this.buildScannedPdfPage(original, pageCount);
    }

    if (hasPageText) {
      return this.buildPerPagePdfContent(
        original,
        pageEntries,
        pageCount,
        pdfInspector,
        fileBuffer,
        workspaceId,
        spaceId,
        pageId,
        userId,
      );
    }

    if (hasFullText) {
      let markdown: string = fullResult.markdown;
      if (fullResult.images && fullResult.images.length > 0) {
        markdown = await this.rewritePdfImagePlaceholders(
          markdown,
          fullResult.images,
          workspaceId,
          spaceId,
          pageId,
          userId,
        );
      }
      const html = await markdownToHtml(markdown);
      return this.processHTML(this.buildPdfViewerNodeHtml(original) + html);
    }

    // Markdown was empty but native text exists: render the text as paragraphs
    // and append any embedded images (extractImages finds images even when
    // processPdfWithImages returns none alongside undefined markdown).
    let images: Array<{
      data: Buffer;
      format: string;
      width: number;
      height: number;
      page: number;
    }> = [];
    try {
      images = pdfInspector.extractImages?.(fileBuffer) ?? [];
    } catch (err) {
      this.logger.warn('PDF extractImages fallback failed', err as Error);
      images = [];
    }

    let imagesHtml = '';
    if (images.length > 0) {
      imagesHtml = await this.uploadPdfImages(
        images,
        workspaceId,
        spaceId,
        pageId,
        userId,
      );
    }

    const paragraphsHtml = fallbackText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => `<p>${escapeHtml(line)}</p>`)
      .join('');

    return this.processHTML(
      this.buildPdfViewerNodeHtml(original) + paragraphsHtml + imagesHtml,
    );
  }

  async rewritePdfImagePlaceholders(
    markdown: string,
    images: Array<{
      data: Buffer;
      format: string;
      width: number;
      height: number;
      page: number;
    }>,
    workspaceId: string,
    spaceId: string,
    pageId: string,
    userId: string,
  ): Promise<string> {
    let result = markdown;

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const placeholder = `pdf-image://${i}`;
      if (!result.includes(placeholder)) continue;

      const attachmentId = uuid7();
      const ext = img.format === 'Jpeg' ? '.jpg' : '.png';
      const fileName = `${attachmentId}${ext}`;
      const storageFilePath = `${getAttachmentFolderPath(
        AttachmentType.File,
        workspaceId,
      )}/${attachmentId}/${fileName}`;
      const apiFilePath = `/api/files/${attachmentId}/${fileName}`;

      try {
        await this.storageService.upload(storageFilePath, img.data);

        await this.db
          .insertInto('attachments')
          .values({
            id: attachmentId,
            filePath: storageFilePath,
            fileName,
            fileSize: img.data.length,
            mimeType: getMimeType(fileName),
            type: AttachmentType.File,
            fileExt: ext,
            creatorId: userId,
            workspaceId,
            pageId,
            spaceId,
          })
          .execute();

        const width = img.width || 600;
        const imgTag = `<img src="${apiFilePath}" data-attachment-id="${attachmentId}" width="${width}" data-align="center" alt="PDF image ${i + 1}">`;

        // Replace the full markdown image `![alt](pdf-image://N)` with the raw
        // <img> tag. Replacing only the bare placeholder leaves behind broken
        // `![image](<img ...>)` markdown which marked renders as a mangled
        // `<img src="img%20src=...">` node.
        const markdownImagePattern = new RegExp(
          `!\\[.*?\\]\\(${escapeRegExp(placeholder)}\\)`,
          'g',
        );
        if (markdownImagePattern.test(result)) {
          result = result.replace(markdownImagePattern, imgTag);
        } else {
          result = result.split(placeholder).join(imgTag);
        }
      } catch (err: any) {
        this.logger.error(
          `Failed to upload PDF image ${i}: ${err?.message ?? err}`,
        );
        result = result.split(placeholder).join('');
      }
    }

    return result;
  }

  /**
   * Uploads embedded PDF images and returns them as raw <img> HTML so the
   * caller can append them to fallback content. Used when the inspector
   * returns images without markdown placeholders.
   */
  async uploadPdfImages(
    images: Array<{
      data: Buffer;
      format: string;
      width: number;
      height: number;
      page: number;
    }>,
    workspaceId: string,
    spaceId: string,
    pageId: string,
    userId: string,
  ): Promise<string> {
    let html = '';

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const attachmentId = uuid7();
      const ext = img.format === 'Jpeg' ? '.jpg' : '.png';
      const fileName = `${attachmentId}${ext}`;
      const storageFilePath = `${getAttachmentFolderPath(
        AttachmentType.File,
        workspaceId,
      )}/${attachmentId}/${fileName}`;
      const apiFilePath = `/api/files/${attachmentId}/${fileName}`;

      try {
        await this.storageService.upload(storageFilePath, img.data);

        await this.db
          .insertInto('attachments')
          .values({
            id: attachmentId,
            filePath: storageFilePath,
            fileName,
            fileSize: img.data.length,
            mimeType: getMimeType(fileName),
            type: AttachmentType.File,
            fileExt: ext,
            creatorId: userId,
            workspaceId,
            pageId,
            spaceId,
          })
          .execute();

        const width = img.width || 600;
        html += `<img src="${apiFilePath}" data-attachment-id="${attachmentId}" width="${width}" data-align="center" alt="PDF image ${i + 1}">`;
      } catch (err: any) {
        this.logger.error(
          `Failed to upload PDF image ${i}: ${err?.message ?? err}`,
        );
      }
    }

    return html;
  }

  /**
   * Stores the original PDF file as an attachment so it can be embedded as a
   * viewer node, downloaded from the attachments tab, and deep-linked with
   * #page=N fragments.
   */
  async storePdfOriginal(
    fileBuffer: Buffer,
    workspaceId: string,
    spaceId: string,
    pageId: string,
    userId: string,
    fileNameWithExt?: string,
  ): Promise<{
    attachmentId: string;
    apiFilePath: string;
    fileName: string;
    fileSize: number;
  }> {
    const safeFileName =
      fileNameWithExt && fileNameWithExt.trim().length > 0
        ? fileNameWithExt
        : `${pageId}.pdf`;
    const attachmentId = uuid7();
    const storageFilePath = `${getAttachmentFolderPath(
      AttachmentType.File,
      workspaceId,
    )}/${attachmentId}/${safeFileName}`;
    const apiFilePath = `/api/files/${attachmentId}/${safeFileName}`;

    await this.storageService.upload(storageFilePath, fileBuffer);

    await this.db
      .insertInto('attachments')
      .values({
        id: attachmentId,
        filePath: storageFilePath,
        fileName: safeFileName,
        fileSize: fileBuffer.length,
        mimeType: getMimeType(safeFileName),
        type: AttachmentType.File,
        fileExt: '.pdf',
        creatorId: userId,
        workspaceId,
        pageId,
        spaceId,
      })
      .execute();

    return {
      attachmentId,
      apiFilePath,
      fileName: safeFileName,
      fileSize: fileBuffer.length,
    };
  }

  private encodeFileUrl(apiFilePath: string): string {
    return encodeURI(apiFilePath);
  }

  private buildPdfViewerNodeHtml(original: {
    attachmentId: string;
    apiFilePath: string;
    fileName: string;
    fileSize: number;
  }): string {
    return (
      `<div data-type="pdf" src="${original.apiFilePath}" ` +
      `data-name="${escapeHtml(original.fileName)}" ` +
      `data-attachment-id="${original.attachmentId}" ` +
      `data-size="${original.fileSize}" width="800" height="600"></div>`
    );
  }

  /**
   * Scanned PDF without OCR-ed text: the document is left as-is. The original
   * file is embedded as a viewer and each page gets an anchor paragraph
   * (data-id="pdf-page-N") linking to the PDF at #page=N. This provides
   * bidirectional page-number references: doc URL #pdf-page-N scrolls to the
   * page anchor, and the anchor link opens the PDF at that page number.
   */
  async buildScannedPdfPage(
    original: {
      attachmentId: string;
      apiFilePath: string;
      fileName: string;
      fileSize: number;
    },
    pageCount: number,
  ): Promise<any> {
    const fileUrl = this.encodeFileUrl(original.apiFilePath);

    let html =
      `<p>This PDF has no extractable text (it appears to be a scanned ` +
      `document), so it is preserved as-is. The original file is embedded ` +
      `below. Use the page links to reference a specific page number.</p>`;
    html += this.buildPdfViewerNodeHtml(original);

    if (pageCount > 0) {
      html += `<h2>Pages</h2>`;
      for (let n = 1; n <= pageCount; n++) {
        html +=
          `<p data-id="pdf-page-${n}">` +
          `<a href="${fileUrl}#page=${n}">Page ${n}</a>` +
          `</p>`;
      }
    }

    return this.processHTML(html);
  }

  /**
   * PDF with extractable (OCR-ed or native) text: builds the most complete
   * representation possible. The original file is embedded at the top, then
   * each PDF page becomes a section with:
   * - an anchored heading (data-id="pdf-page-N") that also links to the
   *   original PDF at #page=N (bidirectional page-number navigation)
   * - the page's markdown text
   * - any images embedded on that page
   * Sections are separated by page breaks. Scanned pages inside an otherwise
   * text-based PDF get a note with a deep link to that page in the viewer.
   */
  async buildPerPagePdfContent(
    original: {
      attachmentId: string;
      apiFilePath: string;
      fileName: string;
      fileSize: number;
    },
    pageEntries: Array<{ page: number; markdown: string; needsOcr: boolean }>,
    pageCount: number,
    pdfInspector: any,
    fileBuffer: Buffer,
    workspaceId: string,
    spaceId: string,
    pageId: string,
    userId: string,
  ): Promise<any> {
    let images: Array<{
      data: Buffer;
      format: string;
      width: number;
      height: number;
      page: number;
    }> = [];
    try {
      images = pdfInspector.extractImages?.(fileBuffer) ?? [];
    } catch (err) {
      this.logger.warn('PDF extractImages failed', err as Error);
      images = [];
    }

    const maxImagePage = images.reduce(
      (max, img) => Math.max(max, img.page ?? 0),
      0,
    );
    const totalPages = Math.max(pageCount, pageEntries.length, maxImagePage, 1);
    const fileUrl = this.encodeFileUrl(original.apiFilePath);

    let html = this.buildPdfViewerNodeHtml(original);

    for (let n = 1; n <= totalPages; n++) {
      if (n > 1) {
        html += `<div data-type="pageBreak"></div>`;
      }

      html +=
        `<h2 data-id="pdf-page-${n}">` +
        `<a href="${fileUrl}#page=${n}">Page ${n}</a>` +
        `</h2>`;

      const entry = pageEntries.find((p) => p.page === n - 1);
      // Strip pdf-image:// placeholders (per-page markdown is combined with
      // real uploaded images below, keyed by the image's page number).
      const pageMarkdown = (entry?.markdown ?? '')
        .replace(/!\[[^\]]*\]\(pdf-image:\/\/\d+\)/g, '')
        .replace(/pdf-image:\/\/\d+/g, '')
        .trim();

      const pageImages = images.filter((img) => img.page === n);

      if (pageMarkdown) {
        html += await markdownToHtml(pageMarkdown);
      }
      if (pageImages.length > 0) {
        html += await this.uploadPdfImages(
          pageImages,
          workspaceId,
          spaceId,
          pageId,
          userId,
        );
      }
      if (!pageMarkdown && pageImages.length === 0) {
        html +=
          `<p>No extractable text on this page (scanned). ` +
          `<a href="${fileUrl}#page=${n}">View page ${n} in the PDF</a>.</p>`;
      }
    }

    return this.processHTML(html);
  }

  async createYdoc(prosemirrorJson: any): Promise<Buffer | null> {
    if (prosemirrorJson) {
      // this.logger.debug(`Converting prosemirror json state to ydoc`);

      const ydoc = TiptapTransformer.toYdoc(
        prosemirrorJson,
        'default',
        tiptapExtensions,
      );

      Y.encodeStateAsUpdate(ydoc);

      return Buffer.from(Y.encodeStateAsUpdate(ydoc));
    }
    return null;
  }

  extractTitleAndRemoveHeading(
    prosemirrorState: any,
    opts?: { anyHeadingLevel?: boolean },
  ) {
    let title: string | null = null;

    const content = prosemirrorState.content ?? [];
    const firstNode = content[0];

    const isTitleHeading =
      firstNode?.type === 'heading' &&
      (opts?.anyHeadingLevel || firstNode.attrs?.level === 1);

    if (isTitleHeading) {
      const headingText = (firstNode.content ?? [])
        .map((node: any) => node.text ?? '')
        .join('')
        .trim();

      if (headingText) {
        title = headingText;
        content.shift();
      }
    }

    // ensure at least one paragraph
    if (content.length === 0) {
      content.push({
        type: 'paragraph',
        content: [],
      });
    }

    return {
      title,
      prosemirrorJson: {
        ...prosemirrorState,
        content,
      },
    };
  }

  async getNewPagePosition(
    spaceId: string,
    parentPageId?: string,
  ): Promise<string> {
    let query = this.db
      .selectFrom('pages')
      .select(['id', 'position'])
      .where('spaceId', '=', spaceId)
      .orderBy('position', (ob) => ob.collate('C').desc())
      .limit(1);

    if (parentPageId) {
      query = query.where('parentPageId', '=', parentPageId);
    } else {
      query = query.where('parentPageId', 'is', null);
    }

    const lastPage = await query.executeTakeFirst();

    if (lastPage) {
      return generateJitteredKeyBetween(lastPage.position, null);
    } else {
      return generateJitteredKeyBetween(null, null);
    }
  }

  async importZip(
    filePromise: Promise<MultipartFile>,
    source: string,
    userId: string,
    spaceId: string,
    workspaceId: string,
  ) {
    const file = await filePromise;
    const fileExtension = path.extname(file.filename).toLowerCase();
    const fileName = sanitizeFileName(
      path.basename(file.filename, fileExtension),
    );
    const fileNameWithExt = fileName + fileExtension;

    const fileTaskId = uuid7();
    const filePath = `${getFileTaskFolderPath(FileTaskType.Import, workspaceId)}/${fileTaskId}/${fileNameWithExt}`;

    // upload file
    const { stream, getBytesRead } = createByteCountingStream(file.file);

    await this.storageService.upload(filePath, stream);

    const fileSize = getBytesRead();

    const fileTask = await this.db
      .insertInto('fileTasks')
      .values({
        id: fileTaskId,
        type: FileTaskType.Import,
        source: source,
        status: FileTaskStatus.Processing,
        fileName: fileNameWithExt,
        filePath: filePath,
        fileSize: fileSize,
        fileExt: 'zip',
        creatorId: userId,
        spaceId: spaceId,
        workspaceId: workspaceId,
      })
      .returningAll()
      .executeTakeFirst();

    await this.fileTaskQueue.add(QueueJob.IMPORT_TASK, {
      fileTaskId: fileTaskId,
    });

    return fileTask;
  }
}
