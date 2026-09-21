#!/usr/bin/env bash
# One-shot deploy: generates .env secrets on first run, then builds & starts the stack.
# Safe to re-run: existing .env values are never overwritten.
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE=".env"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

# Add KEY=VALUE to .env only if the key is not already present
ensure_env() {
  local key="$1" value="$2"
  if ! grep -qE "^${key}=" "$ENV_FILE"; then
    echo "${key}=${value}" >> "$ENV_FILE"
    echo "generated ${key}"
  fi
}

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    # fallback: kernel urandom
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

ensure_env "APP_URL"    "https://docmost.liproject.net"
ensure_env "HTTP_PORT"  "3001"
ensure_env "APP_SECRET" "$(gen_secret)"
ensure_env "DB_PASSWORD" "$(gen_secret)"

docker compose up -d --build
docker compose ps
