import { ImportService } from './import.service';
import { StorageService } from '../../storage/storage.service';
import { getAttachmentFolderPath } from '../../../core/attachment/attachment.utils';
import { AttachmentType } from '../../../core/attachment/attachment.constants';
import { QueueName } from '../../queue/constants/queue.constants';

jest.mock('@docmost/pdf-inspector', () => ({
  classifyPdf: jest.fn(),
  extractPagesMarkdown: jest.fn(),
  processPdfWithImages: jest.fn(),
  extractText: jest.fn(),
  extractImages: jest.fn(),
}));

jest.mock('@docmost/editor-ext', () => ({
  markdownToHtml: jest.fn(),
}));

jest.mock('../../../collaboration/collaboration.util', () => ({
  htmlToJson: jest.fn(),
  jsonToText: jest.fn(),
  tiptapExtensions: [],
}));

jest.mock('../utils/import-formatter', () => ({
  normalizeImportHtml: jest.fn(),
}));

jest.mock('cheerio', () => ({
  load: jest.fn((htmlInput?: string) => ({
    html: jest.fn().mockReturnValue(htmlInput ?? ''),
    root: jest.fn(),
  })),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  classifyPdf,
  extractPagesMarkdown,
  processPdfWithImages,
  extractText,
  extractImages,
} = require('@docmost/pdf-inspector');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { markdownToHtml } = require('@docmost/editor-ext');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { htmlToJson } = require('../../../collaboration/collaboration.util');

describe('ImportService - processPdf', () => {
  let service: ImportService;
  let storageService: { upload: jest.Mock };
  let db: { insertInto: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();

    storageService = { upload: jest.fn().mockResolvedValue(undefined) };

    const executeMock = jest.fn().mockResolvedValue(undefined);
    const valuesMock = jest.fn().mockReturnValue({ execute: executeMock });
    db = {
      insertInto: jest.fn().mockReturnValue({ values: valuesMock }),
    };

    // Instantiate directly, bypassing Nest DI
    service = new ImportService(
      {} as any, // pageRepo - not used by processPdf
      storageService as any,
      db as any,
      { add: jest.fn() } as any, // fileTaskQueue
      {} as any, // moduleRef
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('converts text-based PDF markdown to prosemirror JSON', async () => {
    processPdfWithImages.mockReturnValue({
      markdown: '# Test Title\n\nSome body text here.',
      images: [],
      pageCount: 1,
      pdfType: 'TextBased',
    });
    extractText.mockReturnValue('');
    extractImages.mockReturnValue([]);
    classifyPdf.mockReturnValue({ pageCount: 1, pagesNeedingOcr: [] });
    extractPagesMarkdown.mockReturnValue({ pages: [] });

    markdownToHtml.mockReturnValue(
      '<h1>Test Title</h1><p>Some body text here.</p>',
    );

    htmlToJson.mockReturnValue({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Test Title' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Some body text here.' }],
        },
      ],
    });

    const result = await service.processPdf(
      Buffer.from('fake-pdf'),
      'ws-1',
      'space-1',
      'page-1',
      'user-1',
    );

    expect(result).toBeDefined();
    expect(result.type).toBe('doc');
    expect(result.content[0].type).toBe('heading');
    expect(result.content[1].type).toBe('paragraph');
    expect(processPdfWithImages).toHaveBeenCalledWith(Buffer.from('fake-pdf'));
    // The original PDF is always preserved as an attachment + viewer node
    expect(storageService.upload).toHaveBeenCalledTimes(1);
    const htmlArg = htmlToJson.mock.calls[0][0] as string;
    expect(htmlArg).toContain('data-type="pdf"');
  });

  it('returns viewer with page-number links for scanned PDFs with no text', async () => {
    processPdfWithImages.mockReturnValue({
      markdown: null,
      images: [],
      pageCount: 5,
      pdfType: 'Scanned',
    });
    classifyPdf.mockReturnValue({ pageCount: 5, pagesNeedingOcr: [0, 1, 2, 3, 4] });
    extractPagesMarkdown.mockReturnValue({ pages: [] });
    extractText.mockReturnValue('');
    extractImages.mockReturnValue([]);

    htmlToJson.mockReturnValue({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    });

    const result = await service.processPdf(
      Buffer.from('fake-pdf'),
      'ws-1',
      'space-1',
      'page-1',
      'user-1',
      'scanned.pdf',
    );

    expect(result).toBeDefined();
    expect(result.content[0].type).toBe('paragraph');
    // Original PDF preserved as an attachment instead of a silent empty page
    expect(storageService.upload).toHaveBeenCalledTimes(1);
    expect(db.insertInto).toHaveBeenCalledWith('attachments');
    expect(htmlToJson).toHaveBeenCalled();
    const htmlArg = htmlToJson.mock.calls[0][0] as string;
    expect(htmlArg).toContain('data-type="pdf"');
    // Bidirectional page-number linking: anchors + #page=N deep links per page
    expect(htmlArg).toContain('data-id="pdf-page-1"');
    expect(htmlArg).toContain('data-id="pdf-page-5"');
    expect(htmlArg).toContain('#page=3');
    expect(htmlArg).not.toContain('data-id="pdf-page-6"');
  });

  it('uploads images and replaces pdf-image:// placeholders', async () => {
    const fakeImageBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    processPdfWithImages.mockReturnValue({
      markdown: '# Doc\n\n![image](pdf-image://0)\n\nText after.',
      images: [
        {
          data: fakeImageBuffer,
          format: 'Jpeg',
          width: 800,
          height: 600,
          page: 1,
        },
      ],
      pageCount: 1,
      pdfType: 'TextBased',
    });
    classifyPdf.mockReturnValue({ pageCount: 1, pagesNeedingOcr: [] });
    extractPagesMarkdown.mockReturnValue({ pages: [] });
    extractText.mockReturnValue('');
    extractImages.mockReturnValue([]);

    let capturedMarkdown: string;
    markdownToHtml.mockImplementation((md: string) => {
      capturedMarkdown = md;
      return '<h1>Doc</h1><img src="/api/files/ID/file.jpg"><p>Text after.</p>';
    });

    htmlToJson.mockReturnValue({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 } },
        { type: 'image' },
        { type: 'paragraph' },
      ],
    });

    await service.processPdf(
      Buffer.from('fake-pdf'),
      'ws-1',
      'space-1',
      'page-1',
      'user-1',
    );

    // call 0: original PDF preserved, call 1: extracted image upload
    expect(storageService.upload).toHaveBeenCalledTimes(2);
    const expectedPath = `${getAttachmentFolderPath(AttachmentType.File, 'ws-1')}/`;
    expect(storageService.upload.mock.calls[1][0]).toContain(expectedPath);
    expect(storageService.upload.mock.calls[1][1]).toBe(fakeImageBuffer);

    expect(db.insertInto).toHaveBeenCalledWith('attachments');

    expect(capturedMarkdown).not.toContain('pdf-image://0');
    expect(capturedMarkdown).toContain('<img');
    expect(capturedMarkdown).toContain('/api/files/');
    // Full markdown image syntax must be replaced, not just the bare URL —
    // otherwise marked renders a mangled `![image](<img ...>)` node.
    expect(capturedMarkdown).not.toContain('![image](<img');
  });

  it('falls back to extractText when markdown is empty but native text exists', async () => {
    processPdfWithImages.mockReturnValue({
      markdown: undefined,
      images: [],
      pageCount: 1,
      pdfType: 'ImageBased',
    });
    classifyPdf.mockReturnValue({ pageCount: 1, pagesNeedingOcr: [0] });
    extractPagesMarkdown.mockReturnValue({ pages: [] });
    extractText.mockReturnValue(
      'Doc With Image\n\nText before image.\nText after image that should be visible.\n',
    );
    extractImages.mockReturnValue([]);

    htmlToJson.mockReturnValue({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    });

    const result = await service.processPdf(
      Buffer.from('fake-pdf'),
      'ws-1',
      'space-1',
      'page-1',
      'user-1',
      'report.pdf',
    );

    expect(extractText).toHaveBeenCalled();
    expect(result).toBeDefined();
    // Fallback renders native text as paragraphs alongside the preserved
    // original PDF viewer node.
    const htmlArg = htmlToJson.mock.calls[0][0] as string;
    expect(htmlArg).toContain('Text before image.');
    expect(htmlArg).toContain('Text after image that should be visible.');
    expect(htmlArg).toContain('data-type="pdf"');
  });

  it('builds per-page sections with anchors and deep links when page markdown exists', async () => {
    processPdfWithImages.mockReturnValue({
      markdown: null,
      images: [],
      pageCount: 2,
      pdfType: 'Mixed',
    });
    classifyPdf.mockReturnValue({ pageCount: 2, pagesNeedingOcr: [1] });
    extractPagesMarkdown.mockReturnValue({
      pages: [
        { page: 0, markdown: 'First page text', needsOcr: false },
        { page: 1, markdown: '', needsOcr: true },
      ],
      pagesNeedingOcr: [1],
    });
    extractText.mockReturnValue('');
    extractImages.mockReturnValue([]);

    markdownToHtml.mockImplementation((md: string) => `<p>${md}</p>`);
    htmlToJson.mockReturnValue({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    });

    await service.processPdf(
      Buffer.from('fake-pdf'),
      'ws-1',
      'space-1',
      'page-1',
      'user-1',
      'mixed.pdf',
    );

    // Original preserved
    expect(storageService.upload).toHaveBeenCalledTimes(1);

    const htmlArg = htmlToJson.mock.calls[0][0] as string;
    // Embedded viewer for the original file
    expect(htmlArg).toContain('data-type="pdf"');
    // Per-page anchored headings that link to the PDF page number
    expect(htmlArg).toContain('<h2 data-id="pdf-page-1"><a href="/api/files/');
    expect(htmlArg).toContain('#page=1">Page 1</a></h2>');
    expect(htmlArg).toContain('data-id="pdf-page-2"');
    expect(htmlArg).toContain('#page=2">Page 2</a></h2>');
    // Extracted text for page 1, scanned note for page 2
    expect(htmlArg).toContain('First page text');
    expect(htmlArg).toContain('No extractable text on this page');
    // Page break between pages
    expect(htmlArg).toContain('data-type="pageBreak"');
  });
});