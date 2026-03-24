#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH="${CONFIG_PATH:-./cleaner.config.json}"

usage() {
  cat <<'EOF'
Usage:
  ./run.sh [--config ./cleaner.config.json] [options]

Behavior:
  - Reads config from ./cleaner.config.json by default
  - CLI args override config file values
  - MANAGEMENT_KEY env still works when config leaves managementKey empty

Options:
  --config            Config file path (default ./cleaner.config.json)
  --base-url          Override base URL from config
  --management-key    Override management key from config
  --mode              status|probe|reconcile|recover
  --dry-run           true|false
  --concurrency       Number of concurrent workers
  --retries           Retry count for probe mode
  --disable-after-failures Number of non-401 failures before disable
  --output            Report output path
  --only-provider     Provider filter, e.g. codex
  --include-disabled  true|false
  --state-file        Local state file path
  --probe-url         Optional probe URL override
  --recover-after-successes Successful probes required before re-enable
  --health-sample-rate Fraction of healthy auths to probe per run
  --max-probe-candidates-per-run Hard cap for deep probes per run
  --metrics-enabled   true|false
  --metrics-output    Prometheus textfile output path

Examples:
  ./run.sh --mode reconcile --dry-run true
  ./run.sh --mode reconcile --dry-run false
  ./run.sh --mode recover --dry-run false
  ./run.sh --only-provider codex
  MANAGEMENT_KEY='***' ./run.sh
EOF
}

ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG_PATH="$2"; ARGS+=("$1" "$2"); shift 2;;
    --base-url|--management-key|--mode|--dry-run|--concurrency|--retries|--disable-after-failures|--output|--only-provider|--include-disabled|--state-file|--probe-url|--recover-after-successes|--health-sample-rate|--max-probe-candidates-per-run|--metrics-enabled|--metrics-output)
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
  echo "Copy ./cleaner.config.example.json to ./cleaner.config.json and fill in baseUrl / managementKey." >&2
  exit 2
fi

if [[ ! -d node_modules ]]; then
  pnpm i
fi
if [[ ! -f dist/index.js ]]; then
  pnpm build
fi

exec node dist/index.js --config "$CONFIG_PATH" "${ARGS[@]}"
