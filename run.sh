#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH="${CONFIG_PATH:-./cleaner.config.json}"

usage() {
  cat <<'EOF'
Usage:
  ./run.sh [--config ./cleaner.config.json] [--dry-run true|false] [--only-provider codex]

Behavior:
  - Reads config from ./cleaner.config.json by default
  - CLI args override config file values
  - MANAGEMENT_KEY env still works and overrides empty config values

Options:
  --config            Config file path (default ./cleaner.config.json)
  --base-url          Override base URL from config
  --management-key    Override management key from config
  --mode              status|probe
  --dry-run           true|false
  --concurrency       Number of concurrent workers
  --retries           Retry count for probe mode
  --output            Report output path
  --only-provider     Provider filter, e.g. codex
  --include-disabled  true|false

Examples:
  ./run.sh
  ./run.sh --dry-run false
  ./run.sh --only-provider codex --mode probe
  MANAGEMENT_KEY='***' ./run.sh
EOF
}

ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG_PATH="$2"; ARGS+=("$1" "$2"); shift 2;;
    --base-url|--management-key|--mode|--dry-run|--concurrency|--retries|--output|--only-provider|--include-disabled)
      ARGS+=("$1" "$2"); shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "node not found. Please install Node.js >= 18" >&2
  exit 2
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found. Install: npm i -g pnpm" >&2
  exit 2
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "Config file not found: $CONFIG_PATH" >&2
  echo "You can copy ./cleaner.config.json and fill in your baseUrl / managementKey." >&2
  exit 2
fi

if [[ ! -d node_modules ]]; then
  pnpm i
fi
if [[ ! -d dist ]]; then
  pnpm build
fi

exec node dist/index.js --config "$CONFIG_PATH" "${ARGS[@]}"
