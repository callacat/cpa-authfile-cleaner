# cpa-authfile-cleaner

[中文说明](README.zh-CN.md)

Clean invalid auth files from a CLIProxyAPI management endpoint, but only when the auth can be confirmed as unauthorized (`401`).

This project is meant for operators who want a safer cleanup tool than blindly deleting entries based on message text alone.

## What it does

- Lists auth files from the management API
- Filters by provider when needed
- Supports a safe `dry-run` workflow
- Deletes only when the auth is proven invalid
- Writes a JSON report for review or auditing

## Decision modes

### `status`

Delete only when all of the following are true:

- runtime `status` is missing or equals `error`
- `status_message` is valid JSON
- parsed content contains `status = 401`

### `probe`

- Calls `POST /api-call` for each auth
- Deletes only when the probe result is HTTP `401`

`probe` is slower, but is the stricter option when you want to verify auth validity with a real request.

## Quick start

### From source

Requirements:

- Node.js `>= 18`
- pnpm

Install and build:

```bash
pnpm install
pnpm build
```

Create a config file:

```bash
cp cleaner.config.example.json cleaner.config.json
```

Preview changes first:

```bash
./run.sh --dry-run true
```

Execute deletions:

```bash
./run.sh --dry-run false
```

### From release binaries

Download the archive for your platform from GitHub Releases:

- `linux-x64`
- `linux-arm64`
- `win-x64`

Then:

1. Extract the archive
2. Copy `cleaner.config.example.json` to `cleaner.config.json`
3. Fill in your `baseUrl` and `managementKey`
4. Run the executable

Examples:

```bash
./cpa-authfile-cleaner --help
./cpa-authfile-cleaner --dry-run true
```

On Windows:

```bat
cpa-authfile-cleaner.exe --help
cpa-authfile-cleaner.exe --dry-run true
```

## Configuration

Default config file: `cleaner.config.json`

Example:

```json
{
  "baseUrl": "https://your-host.example.com/v0/management",
  "managementKey": "",
  "mode": "status",
  "dryRun": true,
  "concurrency": 2,
  "retries": 0,
  "output": "report.json",
  "onlyProvider": "codex",
  "includeDisabled": false
}
```

Fields:

- `baseUrl`: management API base path
- `managementKey`: management key, optional if `MANAGEMENT_KEY` is set
- `mode`: `status` or `probe`
- `dryRun`: preview without deleting
- `concurrency`: worker count
- `retries`: probe retry count
- `output`: report output path
- `onlyProvider`: filter by provider name
- `includeDisabled`: include disabled auth files

Management key fallback order:

1. `--management-key`
2. `cleaner.config.json`
3. `MANAGEMENT_KEY`
4. `CPA_MANAGEMENT_KEY`

## CLI usage

```bash
./run.sh --help
```

Common examples:

```bash
./run.sh --dry-run true
./run.sh --mode probe --dry-run true
./run.sh --mode probe --dry-run false
./run.sh --base-url https://example.com/v0/management
./run.sh --only-provider codex
./run.sh --config ./prod-cleaner.json
```

## Output

Console summary example:

```text
total=120 delete=17 keep=103 dryRun=true
```

If `output` is set, the tool also writes a JSON report.

## API endpoints used

Base path: `.../v0/management`

- `GET /auth-files`
- `DELETE /auth-files?name=<file.json>`
- `POST /api-call`

## Release automation

GitHub Actions builds release binaries for:

- Linux x64
- Linux arm64
- Windows x64

The workflow runs on tag push such as `v0.1.0`, uploads artifacts, and publishes them to GitHub Releases.

## Notes

- Linux release binaries are built against `glibc`
- Windows binaries are unsigned
- Do not commit real `managementKey` values to a public repo
