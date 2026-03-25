# cpa-authfile-cleaner

[中文说明](README.zh-CN.md)

Manage CLIProxyAPI auth files more safely: delete confirmed `401` auths, disable flaky auths, and re-enable only after repeated successful probes.

## What it does

- Lists auth files from the management API
- Filters by provider when needed
- Supports safe `dry-run` runs
- Deletes only when the auth is confirmed unauthorized (`401`)
- Disables non-`401` failures instead of deleting them
- Re-enables only auths previously disabled by this tool after `2` successful probes
- Writes a JSON report, a local state file, and optional Prometheus textfile metrics

`dry-run` note:

- `dryRun=true` does not delete, disable, enable, or persist `auth-state.json`
- `dryRun=false` executes remote actions and saves updated local state

If you only remember one rule:

- confirmed `401` -> delete
- not `401`, but still unhealthy -> disable first
- healthy again later -> re-enable only after repeated success

## Which file does what

Files most people care about:

- `cleaner.config.json`: your real local config; this is the file you edit before running
- `run.sh`: the easiest way to run from source
- `report.json`: the result of one run; read this first when you want to know what happened
- `auth-state.json`: the tool's memory between runs

Default mindset:

- in most setups, you only need `baseUrl` and `managementKey`
- let the management side choose how to probe by default
- `onlyProvider` and `probeUrl` are optional override knobs, not daily config

Compatibility note:

- tested old behavior: CLI Proxy API `v6.9.1` + Management Center `v1.7.15` accepts `POST /api-call` without `url`
- tested new behavior: CLI Proxy API `v6.9.2` + Management Center `v1.7.16` returns `400 {"error":"missing url"}` when `url` is omitted
- the tool now probes this once at startup and automatically falls back to a default probe URL when the management side requires it

Code and support files:

- `src/index.ts`: CLI entrypoint; reads config, picks mode, runs the whole workflow
- `src/http.ts`: small HTTP wrapper for the management API
- `src/probe.ts`: sends the safe test request used to judge whether an auth still works
- `src/state.ts`: loads, cleans, saves, and repairs the local state file
- `src/metrics.ts`: writes Prometheus textfile metrics
- `src/types.ts`: shared TypeScript types
- `cleaner.config.example.json`: config template for new setups
- `scripts/build-release.mjs`: builds the release binaries and archives

Mostly generated output:

- `dist/`: compiled TypeScript output
- `build/`, `releases/`, `release-bundles/`: packaging artifacts; usually not hand-edited

## Modes

### `reconcile`

Recommended default.

- Runs layered inspection
- Deletes auths confirmed as `401`
- Disables auths with non-`401` probe failures
- Keeps local history in `auth-state.json`

### `recover`

- Checks only auths previously disabled by this tool
- Re-enables after `recoverAfterSuccesses` consecutive successful probes

### Legacy modes

- `status`: delete only when `status_message` proves `401`
- `probe`: probe selected auths and delete only on `401`

Legacy behavior note:

- `status` and `probe` keep the old delete-only behavior
- only `reconcile` and `recover` use local state tracking, disable/enable flow, layered inspection, and recovery logic

## Why local state matters

CLIProxyAPI runtime fields such as `status`, `status_message`, and `unavailable` only tell you what things look like right now. They can disappear after one successful call or after a restart. So the tool keeps its own `auth-state.json` to remember:

- which auths it disabled
- whether an auth was already disabled before the tool touched it
- how many consecutive probe successes or failures have happened
- when backoff should delay another probe

How the state file behaves:

- after each non-`dry-run` pass, stale state entries are pruned automatically
- entries are removed only when the auth no longer exists remotely and is not still tool-managed as disabled
- saved state is normalized with stable key order and atomic writes to reduce diff noise and partial-write risk
- obsolete local-only fields are cleaned up on the next persisted state rewrite
- broken or invalid state files are auto-rotated to `auth-state.json.broken.<ts>.json` or `auth-state.json.invalid.<ts>.json` before recovery from an empty state

## Layered inspection

For large auth pools, the tool does not probe everything every run.

- Full light scan: all auths from `GET /auth-files`
- Probe priority: suspicious auths, tool-managed disabled auths, then a healthy sample
- Backoff: repeated failures are retried less aggressively

This keeps the tool practical for thousands of auths.

Current reconcile behavior:

- suspicious auths are always probed first
- tool-managed disabled auths are always considered for recovery
- suspicious auths are all probed; they are not capped by healthy sampling budget
- tool-managed disabled auths are all considered for recovery
- `maxProbeCandidatesPerRun` only limits healthy sampling, not suspicious or managed-disabled auths

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

Preview a reconcile run:

```bash
./run.sh --mode reconcile --dry-run true
```

Apply actions:

```bash
./run.sh --mode reconcile --dry-run false
```

Recovery pass:

```bash
./run.sh --mode recover --dry-run false
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

## Configuration

Default config file: `cleaner.config.json`

Example:

```json
{
  "baseUrl": "https://your-host.example.com/v0/management",
  "managementKey": "",
  "mode": "reconcile",
  "dryRun": true,
  "concurrency": 8,
  "retries": 0,
  "disableAfterFailures": 2,
  "output": "report.json",
  "includeDisabled": true,
  "stateFile": "auth-state.json",
  "recoverAfterSuccesses": 2,
  "healthSampleRate": 0.1,
  "maxProbeCandidatesPerRun": 200,
  "metrics": {
    "enabled": false,
    "output": "metrics.prom"
  }
}
```

Fields:

- `baseUrl`: management API base path
- `managementKey`: management key, optional if `MANAGEMENT_KEY` is set
- `mode`: `status`, `probe`, `reconcile`, or `recover`
- `dryRun`: preview without changing remote auth state
- `concurrency`: worker count for probe/action work
- `retries`: retry count for probe mode
- `disableAfterFailures`: consecutive non-`401` probe failures required before disable
- `output`: JSON report path
- `includeDisabled`: include disabled auth files in the source list
- `stateFile`: local state file path
- `recoverAfterSuccesses`: successful probes required before enable
- `healthSampleRate`: fraction of healthy auths sampled per reconcile run
- `maxProbeCandidatesPerRun`: hard cap for deep probes in one run
- `metrics.enabled`: write Prometheus textfile metrics
- `metrics.output`: path for the Prometheus textfile

Optional advanced overrides:

- `onlyProvider`: process only one provider type; useful for staged cleanup or debugging
- `probeUrl`: force one specific probe URL; useful only when you do not want the management side to choose automatically

Default recommendation:

- leave `probeUrl` unset first
- if the management side accepts missing `url`, the tool lets management choose the target
- if the management side rejects missing `url`, the tool auto-falls back for this run
- set `probeUrl` manually only when you want to force a specific endpoint

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
./run.sh --mode reconcile --dry-run true
./run.sh --mode reconcile --dry-run false
./run.sh --mode recover --dry-run false
./run.sh --only-provider codex
./run.sh --probe-url https://api.openai.com/v1/models
./run.sh --metrics-enabled true --metrics-output ./metrics.prom
```

## Output files

- `report.json`: the run report; what the tool decided, and why
- `auth-state.json`: the tool's memory; used to avoid overreacting and to support recovery
- `metrics.prom`: optional Prometheus textfile output for monitoring

Metric note:

- `cpa_authfiles_state_pruned_total`: stale local state entries compacted in the current run
- `cpa_authfiles_state_changed`: whether effective local state content changed in the current run
- `cpa_authfiles_state_normalized`: whether loaded local state needed normalization in the current run
- `cpa_authfiles_state_recovered`: whether a broken local state file was recovered in the current run
- `cpa_authfiles_state_save_duration_seconds`: time spent saving local state in the current run
- `report.json` also includes `prunedStateEntries`, `stateChanged`, `stateNormalized`, `stateRecovered`, `stateRecoveryBackupPath`, and `stateSaved` for easier auditing

Test note:

- if your management endpoint returns HTML instead of JSON, the `baseUrl` points to the wrong service or a frontend/reverse proxy route

Console summary example:

```text
total=120 delete=3 disable=11 enable=2 keep=96 skip=8 pruned=14 stateChanged=true stateSaved=true dryRun=false mode=reconcile
```

## API endpoints used

Base path: `.../v0/management`

- `GET /auth-files`
- `DELETE /auth-files?name=<file.json>`
- `POST /api-call`
- `PATCH /auth-files/status`

## Scheduling

Recommended:

- `reconcile`: every `15` minutes
- `recover`: every `30` minutes

Example cron:

```cron
*/15 * * * * /path/to/cpa-authfile-cleaner --config /path/to/cleaner.config.json --mode reconcile --dry-run false
*/30 * * * * /path/to/cpa-authfile-cleaner --config /path/to/cleaner.config.json --mode recover --dry-run false
```

## Release automation

GitHub Actions builds release binaries for:

- Linux x64
- Linux arm64
- Windows x64

The workflow runs on tag push such as `v0.1.0`, uploads artifacts, and publishes them to GitHub Releases.

For local testing on an ARM64 machine, you can build only the ARM64 package without affecting the GitHub Actions multi-platform release flow:

```bash
pnpm release:linux-arm64
```

## Notes

- Linux release binaries are built against `glibc`
- Windows binaries are unsigned
- Do not commit real `managementKey` values to a public repo
- Prometheus textfile output is designed for node-exporter textfile collector style setups
