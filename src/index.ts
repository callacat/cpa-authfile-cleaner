#!/usr/bin/env node
import pLimit from 'p-limit';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HttpClient } from './http.js';
import { createEmptyRunMetrics, writePrometheusTextfile } from './metrics.js';
import { DEFAULT_PROBE_URL, probeAuth, shouldForceProbeUrl } from './probe.js';
import { compactState, createDefaultEntry, getStateEntry, hasStateChanged, loadState, saveState, upsertStateEntry } from './state.js';
import type {
  ActionDecision,
  AuthFileItem,
  AuthFilesResponse,
  AuthStateEntry,
  CandidateKind,
  LegacyMode,
  MetricsConfig,
  RunMetrics,
  RunMode,
  StructuredErrorLike
} from './types.js';

type Args = {
  config: string;
  baseUrl: string;
  managementKey?: string;
  concurrency: number;
  retries: number;
  disableAfterFailures: number;
  dryRun: boolean;
  output?: string;
  onlyProvider?: string;
  includeDisabled: boolean;
  mode: RunMode;
  stateFile: string;
  probeUrl?: string;
  recoverAfterSuccesses: number;
  healthSampleRate: number;
  maxProbeCandidatesPerRun: number;
  metrics: MetricsConfig;
};

type ConfigFile = Partial<{
  baseUrl: string;
  managementKey: string;
  concurrency: number;
  retries: number;
  disableAfterFailures: number;
  dryRun: boolean;
  output: string;
  onlyProvider: string;
  includeDisabled: boolean;
  mode: RunMode;
  stateFile: string;
  probeUrl: string;
  recoverAfterSuccesses: number;
  healthSampleRate: number;
  maxProbeCandidatesPerRun: number;
  metrics: Partial<MetricsConfig>;
}>;

void main().catch((error: any) => {
  console.error(error?.message ?? error);
  process.exit(1);
});

async function main(): Promise<void> {
  const startedAt = Date.now();
  const defaultConfigPath = resolve(process.cwd(), 'cleaner.config.json');
  const rawArgv = process.argv.slice(2);
  const preConfigPath = getStringFlag(rawArgv, 'config');
  const configPath = resolve(preConfigPath ?? defaultConfigPath);
  const fileConfig = await loadConfig(configPath);

  if (hasFlag(rawArgv, 'help') || hasShortFlag(rawArgv, 'h')) {
    printHelp(defaultConfigPath);
    return;
  }

  const baseUrl = getStringFlag(rawArgv, 'base-url') ?? fileConfig.baseUrl;
  if (!baseUrl) {
    console.error(`Missing base URL. Set it in ${configPath} or pass --base-url`);
    process.exit(2);
  }

  const metricsConfig = normalizeMetricsConfig(configPath, fileConfig.metrics, getBooleanFlag(rawArgv, 'metrics-enabled', undefined), getStringFlag(rawArgv, 'metrics-output'));
  const args: Args = {
    config: configPath,
    baseUrl,
    managementKey: getStringFlag(rawArgv, 'management-key') ?? fileConfig.managementKey,
    concurrency: getNumberFlag(rawArgv, 'concurrency', fileConfig.concurrency ?? 8),
    retries: getNumberFlag(rawArgv, 'retries', fileConfig.retries ?? 0),
    disableAfterFailures: getNumberFlag(rawArgv, 'disable-after-failures', fileConfig.disableAfterFailures ?? 2),
    dryRun: getBooleanFlag(rawArgv, 'dry-run', fileConfig.dryRun ?? true) ?? (fileConfig.dryRun ?? true),
    output: getStringFlag(rawArgv, 'output') ?? fileConfig.output ?? 'report.json',
    onlyProvider: getStringFlag(rawArgv, 'only-provider') ?? fileConfig.onlyProvider,
    includeDisabled:
      getBooleanFlag(rawArgv, 'include-disabled', fileConfig.includeDisabled ?? false) ?? (fileConfig.includeDisabled ?? false),
    mode: getModeFlag(rawArgv, fileConfig.mode ?? 'reconcile'),
    stateFile: resolve(getStringFlag(rawArgv, 'state-file') ?? fileConfig.stateFile ?? 'auth-state.json'),
    probeUrl: getStringFlag(rawArgv, 'probe-url') ?? fileConfig.probeUrl,
    recoverAfterSuccesses: getNumberFlag(rawArgv, 'recover-after-successes', fileConfig.recoverAfterSuccesses ?? 2),
    healthSampleRate: getFloatFlag(rawArgv, 'health-sample-rate', fileConfig.healthSampleRate ?? 0.1),
    maxProbeCandidatesPerRun: getNumberFlag(rawArgv, 'max-probe-candidates-per-run', fileConfig.maxProbeCandidatesPerRun ?? 200),
    metrics: metricsConfig
  };

  const key = args.managementKey ?? process.env.MANAGEMENT_KEY ?? process.env.CPA_MANAGEMENT_KEY;
  if (!key) {
    console.error(`Missing management key. Set it in ${configPath}, pass --management-key, or export MANAGEMENT_KEY`);
    process.exit(2);
  }

  const metrics = createEmptyRunMetrics();
  const client = new HttpClient({ baseUrl: args.baseUrl, managementKey: key });
  const loadedState = await loadState(args.stateFile);
  const state = loadedState.state;
  const previousState = structuredClone(state);
  metrics.stateNormalized = loadedState.normalized ? 1 : 0;
  metrics.stateRecovered = loadedState.recovered ? 1 : 0;
  const list = await client.json<AuthFilesResponse>('GET', '/auth-files');
  const listedFiles = list.files ?? [];
  const probeUrl = await resolveProbeUrl(args, client, listedFiles);
  let files = listedFiles;
  if (!args.includeDisabled && args.mode !== 'recover') {
    files = files.filter((file) => !file.disabled);
  }
  if (args.onlyProvider) {
    const provider = args.onlyProvider.toLowerCase();
    files = files.filter((file) => String(file.provider ?? file.type ?? '').toLowerCase() === provider);
  }

  metrics.seenTotal = files.length;
  const decisions = await runMode({ ...args, probeUrl }, client, state, files, metrics);
  metrics.prunedStateEntriesTotal = compactState(state, listedFiles.map((file) => file.name));

  metrics.stateEntries = Object.keys(state.entries).length;
  metrics.managedDisabled = Object.values(state.entries).filter((entry) => entry.currentAction === 'disabled' && entry.managedByTool).length;
  metrics.stateChanged = hasStateChanged(previousState, state) ? 1 : 0;
  metrics.runDurationSeconds = (Date.now() - startedAt) / 1000;
  metrics.runTimestampSeconds = Math.floor(Date.now() / 1000);

  let stateSaved = false;
  const stateSaveStartedAt = Date.now();
  if (!args.dryRun) {
    stateSaved = await saveState(args.stateFile, state, previousState);
    metrics.stateSaveDurationSeconds = (Date.now() - stateSaveStartedAt) / 1000;
  }

  const deleted = decisions.filter((decision) => decision.action === 'delete').length;
  const disabled = decisions.filter((decision) => decision.action === 'disable').length;
  const enabled = decisions.filter((decision) => decision.action === 'enable').length;
  const kept = decisions.filter((decision) => decision.action === 'keep').length;
  const skipped = decisions.filter((decision) => decision.action === 'skip').length;

  const report = {
    at: new Date().toISOString(),
    config: configPath,
    baseUrl: args.baseUrl,
    dryRun: args.dryRun,
    mode: args.mode,
    stateFile: args.stateFile,
    probeUrl,
    stateSaved,
    stateChanged: Boolean(metrics.stateChanged),
    stateNormalized: Boolean(metrics.stateNormalized),
    stateRecovered: Boolean(metrics.stateRecovered),
    stateRecoveryBackupPath: loadedState.backupPath,
    prunedStateEntries: metrics.prunedStateEntriesTotal,
    total: decisions.length,
    deleted,
    disabled,
    enabled,
    kept,
    skipped,
    items: decisions
  };

  console.log(
    `total=${report.total} delete=${report.deleted} disable=${report.disabled} enable=${report.enabled} keep=${report.kept} skip=${report.skipped} pruned=${report.prunedStateEntries} stateChanged=${report.stateChanged} stateSaved=${report.stateSaved} dryRun=${report.dryRun} mode=${report.mode}`
  );
  if (report.stateRecovered && report.stateRecoveryBackupPath) {
    console.log(`state recovered: moved broken file to ${report.stateRecoveryBackupPath}`);
  }
  for (const decision of decisions) {
    if (decision.action === 'delete' || decision.action === 'disable' || decision.action === 'enable') {
      console.log(`${decision.action.toUpperCase()} ${decision.name} (${decision.provider ?? ''}) ${decision.reason}`);
    }
  }

  if (args.output) {
    await writeFile(args.output, JSON.stringify(report, null, 2), 'utf8');
    console.log(`report written: ${args.output}`);
  }
  if (args.metrics.enabled) {
    await writePrometheusTextfile(args.metrics.output, metrics);
    console.log(`metrics written: ${args.metrics.output}`);
  }
}

async function runMode(
  args: Args,
  client: HttpClient,
  state: { entries: Record<string, AuthStateEntry> },
  files: AuthFileItem[],
  metrics: RunMetrics
): Promise<ActionDecision[]> {
  if (args.mode === 'recover') {
    return runRecover(args, client, state, files, metrics);
  }
  if (args.mode === 'status' || args.mode === 'probe') {
    return runLegacy(args, client, files, metrics, args.mode);
  }
  return runReconcile(args, client, state, files, metrics);
}

async function resolveProbeUrl(args: Args, client: HttpClient, files: AuthFileItem[]): Promise<string | undefined> {
  if (args.probeUrl) return args.probeUrl;
  const probeCandidate = files.find((file) => file.auth_index !== undefined && file.auth_index !== null && file.auth_index !== '');
  if (!probeCandidate) return undefined;
  const requiresUrl = await shouldForceProbeUrl(client, probeCandidate.auth_index as number | string);
  return requiresUrl ? getDefaultProbeUrlForProvider(probeCandidate) : undefined;
}

function getDefaultProbeUrlForProvider(file: AuthFileItem): string {
  const provider = String(file.provider ?? file.type ?? '').toLowerCase();
  if (provider === 'codex' || provider === 'openai') return DEFAULT_PROBE_URL;
  return DEFAULT_PROBE_URL;
}

async function runLegacy(
  args: Args,
  client: HttpClient,
  files: AuthFileItem[],
  metrics: RunMetrics,
  mode: LegacyMode
): Promise<ActionDecision[]> {
  const decisions: ActionDecision[] = [];
  const limit = pLimit(Math.max(1, args.concurrency));

  await Promise.all(
    files.map((file) =>
      limit(async () => {
        const authIndex = file.auth_index;
        if (authIndex === undefined || authIndex === null || authIndex === '') {
          metrics.skippedTotal += 1;
          decisions.push(makeDecision(file, 'skip', 'skip: missing auth_index'));
          return;
        }

        if (mode === 'status') {
          const hit = shouldDeleteByStatusMessage(file);
          if (hit) {
            if (!args.dryRun) {
              await client.json('DELETE', `/auth-files?name=${encodeURIComponent(file.name)}`);
            }
            metrics.deletedTotal += 1;
            decisions.push(makeDecision(file, 'delete', 'delete: status_message confirms status 401'));
            return;
          }
          metrics.keptTotal += 1;
          decisions.push(makeDecision(file, 'keep', 'keep: status_message does not prove status 401'));
          return;
        }

        const probe = await withRetries(args.retries, async () => probeAuth(client, authIndex, String(file.provider ?? file.type ?? ''), args.probeUrl));
        recordProbeMetrics(metrics, probe);
        if (!probe.ok && probe.status401) {
          if (!args.dryRun) {
            await client.json('DELETE', `/auth-files?name=${encodeURIComponent(file.name)}`);
          }
          metrics.deletedTotal += 1;
          decisions.push(makeDecision(file, 'delete', 'delete: status 401 (probe)', probe));
          return;
        }

        metrics.keptTotal += 1;
        decisions.push(makeDecision(file, 'keep', probe.ok ? 'keep: probe ok' : `keep: probe failed (status=${probe.status ?? 'n/a'})`, probe));
      })
    )
  );

  return sortDecisions(decisions);
}

async function runReconcile(
  args: Args,
  client: HttpClient,
  state: { entries: Record<string, AuthStateEntry> },
  files: AuthFileItem[],
  metrics: RunMetrics
): Promise<ActionDecision[]> {
  const decisions: ActionDecision[] = [];
  const limit = pLimit(Math.max(1, args.concurrency));
  const mode: LegacyMode = args.mode === 'status' ? 'status' : 'probe';
  const candidates = selectReconcileCandidates(args, state.entries, files, mode, metrics);

  await Promise.all(
    candidates.map((candidate) =>
      limit(async () => {
        const decision = await inspectCandidate(args, client, state, candidate.file, candidate.kind, mode, false, metrics);
        decisions.push(decision);
      })
    )
  );

  const inspectedNames = new Set(candidates.map((candidate) => candidate.file.name));
  for (const file of files) {
    if (inspectedNames.has(file.name)) continue;
    const authIndex = file.auth_index;
    if (authIndex === undefined || authIndex === null || authIndex === '') {
      const decision = makeDecision(file, 'skip', 'skip: missing auth_index');
      decisions.push(decision);
      metrics.skippedTotal += 1;
      continue;
    }
    decisions.push(makeDecision(file, 'keep', 'keep: not selected for probe this run'));
    metrics.keptTotal += 1;
    ensureStateEntry(state.entries, file);
  }

  return sortDecisions(decisions);
}

async function runRecover(
  args: Args,
  client: HttpClient,
  state: { entries: Record<string, AuthStateEntry> },
  files: AuthFileItem[],
  metrics: RunMetrics
): Promise<ActionDecision[]> {
  const decisions: ActionDecision[] = [];
  const limit = pLimit(Math.max(1, args.concurrency));
  const recoverFiles = files.filter((file) => {
    const entry = state.entries[file.name];
    return Boolean(file.disabled && entry?.managedByTool && entry.currentAction === 'disabled');
  });
  metrics.managedDisabledCandidates = recoverFiles.length;

  await Promise.all(
    recoverFiles.map((file) =>
      limit(async () => {
        const decision = await inspectCandidate(args, client, state, file, 'managed-disabled', 'probe', true, metrics);
        decisions.push(decision);
      })
    )
  );

  return sortDecisions(decisions);
}

function selectReconcileCandidates(
  args: Args,
  entries: Record<string, AuthStateEntry>,
  files: AuthFileItem[],
  mode: LegacyMode,
  metrics: RunMetrics
): Array<{ file: AuthFileItem; kind: CandidateKind }> {
  if (mode === 'status') {
    return files.map((file) => ({ file, kind: 'legacy-all' as CandidateKind }));
  }

  const suspicious: AuthFileItem[] = [];
  const managedDisabled: AuthFileItem[] = [];
  const healthy: AuthFileItem[] = [];

  for (const file of files) {
    const entry = entries[file.name];
    if (file.disabled && entry?.managedByTool && entry.currentAction === 'disabled') {
      managedDisabled.push(file);
      continue;
    }
    if (isSuspicious(file, entry)) {
      suspicious.push(file);
      continue;
    }
    if (!file.disabled) healthy.push(file);
  }

  const sampledHealthy = sampleHealthyFiles(healthy, entries, args.healthSampleRate, args.maxProbeCandidatesPerRun - suspicious.length - managedDisabled.length);
  metrics.suspiciousCandidates = suspicious.length;
  metrics.managedDisabledCandidates = managedDisabled.length;
  metrics.healthySampleCandidates = sampledHealthy.length;

  return [
    ...suspicious.map((file) => ({ file, kind: 'suspicious' as CandidateKind })),
    ...managedDisabled.map((file) => ({ file, kind: 'managed-disabled' as CandidateKind })),
    ...sampledHealthy.map((file) => ({ file, kind: 'healthy-sample' as CandidateKind }))
  ];
}

function sampleHealthyFiles(
  files: AuthFileItem[],
  entries: Record<string, AuthStateEntry>,
  rate: number,
  maxCount: number
): AuthFileItem[] {
  if (maxCount <= 0 || files.length === 0) return [];
  const targetCount = Math.min(files.length, Math.max(1, Math.floor(files.length * clamp(rate, 0, 1))));
  const count = Math.min(targetCount, maxCount);
  const ranked = files
    .map((file) => ({ file, score: getSampleScore(file.name, entries[file.name]) }))
    .sort((left, right) => left.score - right.score)
    .slice(0, count)
    .map((item) => item.file);
  return ranked;
}

async function inspectCandidate(
  args: Args,
  client: HttpClient,
  state: { entries: Record<string, AuthStateEntry> },
  file: AuthFileItem,
  kind: CandidateKind,
  mode: LegacyMode,
  recoverOnly: boolean,
  metrics: RunMetrics
): Promise<ActionDecision> {
  const authIndex = file.auth_index;
  if (authIndex === undefined || authIndex === null || authIndex === '') {
    metrics.skippedTotal += 1;
    return makeDecision(file, 'skip', 'skip: missing auth_index');
  }

  const entry = ensureStateEntry(state.entries, file);
  if (mode === 'status') {
    const hit = shouldDeleteByStatusMessage(file);
    if (hit) {
      entry.currentAction = 'deleted';
      entry.managedByTool = true;
      entry.lastDeletedAt = new Date().toISOString();
      if (!args.dryRun) {
        await client.json('DELETE', `/auth-files?name=${encodeURIComponent(file.name)}`);
      }
      metrics.deletedTotal += 1;
      return makeDecision(file, 'delete', 'delete: status_message confirms status 401');
    }
    metrics.keptTotal += 1;
    return makeDecision(file, 'keep', 'keep: status_message does not prove status 401');
  }

  const nowIso = new Date().toISOString();
  if (entry.backoffUntil && entry.backoffUntil > nowIso && kind !== 'managed-disabled') {
    metrics.skippedTotal += 1;
    return makeDecision(file, 'skip', `skip: backoff until ${entry.backoffUntil}`);
  }

  const probe = await withRetries(args.retries, async () => probeAuth(client, authIndex, String(file.provider ?? file.type ?? ''), args.probeUrl));
  recordProbeMetrics(metrics, probe);
  entry.lastCheckedAt = nowIso;
  entry.authIndex = authIndex;
  entry.provider = String(file.provider ?? file.type ?? '');
  entry.lastProbeStatus = probe.status;
  entry.lastProbeOk = probe.ok;

  if (!probe.ok && probe.status401) {
    entry.managedByTool = true;
    entry.currentAction = 'deleted';
    entry.disableReason = undefined;
    entry.lastDeletedAt = nowIso;
    entry.consecutiveFailures += 1;
    entry.consecutiveSuccesses = 0;
    entry.lastFailedAt = nowIso;
    entry.backoffUntil = undefined;
    if (!args.dryRun) {
      await client.json('DELETE', `/auth-files?name=${encodeURIComponent(file.name)}`);
    }
    metrics.deletedTotal += 1;
    return makeDecision(file, 'delete', 'delete: status 401 (probe)', probe);
  }

  if (probe.ok) {
    entry.consecutiveSuccesses += 1;
    entry.consecutiveFailures = 0;
    entry.backoffUntil = undefined;
    if ((recoverOnly || file.disabled) && entry.managedByTool && entry.currentAction === 'disabled') {
      if (entry.consecutiveSuccesses >= args.recoverAfterSuccesses) {
        entry.currentAction = 'none';
        entry.disableReason = undefined;
        entry.lastEnabledAt = nowIso;
        if (!args.dryRun) {
          await client.setAuthDisabled({ name: file.name, disabled: false });
        }
        metrics.enabledTotal += 1;
        return makeDecision(file, 'enable', `enable: ${entry.consecutiveSuccesses} consecutive successful probes`, probe);
      }
      metrics.keptTotal += 1;
      return makeDecision(file, 'keep', `keep: recovery progress ${entry.consecutiveSuccesses}/${args.recoverAfterSuccesses}`, probe);
    }

    metrics.keptTotal += 1;
    return makeDecision(file, 'keep', 'keep: probe ok', probe);
  }

  entry.consecutiveFailures += 1;
  entry.consecutiveSuccesses = 0;
  entry.lastFailedAt = nowIso;
  entry.backoffUntil = recoverOnly ? undefined : buildBackoffUntil(entry.consecutiveFailures);
  if (!recoverOnly && !file.disabled) {
    if (entry.consecutiveFailures < args.disableAfterFailures) {
      metrics.keptTotal += 1;
      return makeDecision(
        file,
        'keep',
        `keep: non-401 probe failure ${entry.consecutiveFailures}/${args.disableAfterFailures} before disable (${describeNon401Failure(probe)})`,
        probe
      );
    }
    entry.managedByTool = true;
    entry.currentAction = 'disabled';
    entry.disableReason = describeNon401Failure(probe);
    entry.lastDisabledAt = nowIso;
    if (!args.dryRun) {
      await client.setAuthDisabled({ name: file.name, disabled: true });
    }
    metrics.disabledTotal += 1;
    return makeDecision(file, 'disable', `disable: ${entry.disableReason}`, probe);
  }

  metrics.keptTotal += 1;
  return makeDecision(file, 'keep', `keep: probe failed (${describeNon401Failure(probe)})`, probe);
}

function recordProbeMetrics(metrics: RunMetrics, probe: Awaited<ReturnType<typeof probeAuth>>): void {
  metrics.probeTotal += 1;
  metrics.probeDurationSecondsSum += probe.durationMs / 1000;
  if (probe.ok) {
    metrics.probeOkTotal += 1;
    return;
  }
  if (probe.status401) {
    metrics.probeStatus401Total += 1;
    return;
  }
  metrics.probeFailedTotal += 1;
}

function ensureStateEntry(entries: Record<string, AuthStateEntry>, file: AuthFileItem): AuthStateEntry {
  const existing = getStateEntry({ version: 1, updatedAt: '', entries }, file.name);
  if (existing) {
    existing.authIndex = file.auth_index;
    existing.provider = String(file.provider ?? file.type ?? '');
    return existing;
  }
  const entry = createDefaultEntry(file.name, {
    authIndex: file.auth_index,
    provider: String(file.provider ?? file.type ?? ''),
    originalDisabled: Boolean(file.disabled)
  });
  upsertStateEntry({ version: 1, updatedAt: '', entries }, entry);
  return entry;
}

function shouldDeleteByStatusMessage(file: AuthFileItem): boolean {
  const runtimeStatus = normalizeString(file.status);
  if (runtimeStatus && runtimeStatus !== 'error') return false;
  const parsed = parseStatusMessage(file.status_message ?? file.statusMessage);
  if (!parsed) return false;
  return containsExact401Status(parsed);
}

function parseStatusMessage(value: unknown): StructuredErrorLike | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isObject(parsed) ? (parsed as StructuredErrorLike) : null;
  } catch {
    return null;
  }
}

function containsExact401Status(root: StructuredErrorLike): boolean {
  const queue: unknown[] = [root];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!isObject(current) || seen.has(current)) continue;
    seen.add(current);
    const status = normalizeStatus((current as StructuredErrorLike).status);
    if (status === 401) return true;
    const object = current as StructuredErrorLike;
    if (isObject(object.error)) queue.push(object.error);
    if (isObject(object.details)) queue.push(object.details);
    if (isObject(object.data)) queue.push(object.data);
  }
  return false;
}

function isSuspicious(file: AuthFileItem, entry?: AuthStateEntry): boolean {
  const status = normalizeString(file.status);
  if (status === 'error' || Boolean(file.unavailable)) return true;
  if (shouldDeleteByStatusMessage(file)) return true;
  if (entry?.consecutiveFailures && entry.consecutiveFailures > 0) return true;
  return false;
}

function describeNon401Failure(probe: Awaited<ReturnType<typeof probeAuth>>): string {
  if (probe.ok) return 'probe ok';
  if (probe.quotaExceeded) return probe.reason;
  if (probe.rateLimited) return probe.reason;
  if (probe.upstreamStatus !== undefined) return probe.reason;
  if (probe.outerStatus !== undefined) return probe.reason;
  if (probe.status !== undefined) return probe.reason;
  return `probe failed kind=${probe.errorKind}`;
}

function buildBackoffUntil(consecutiveFailures: number): string {
  const minutes = consecutiveFailures <= 1 ? 15 : consecutiveFailures === 2 ? 30 : consecutiveFailures === 3 ? 60 : 240;
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function getSampleScore(name: string, entry?: AuthStateEntry): number {
  const lastChecked = entry?.lastCheckedAt ? Date.parse(entry.lastCheckedAt) : 0;
  return lastChecked || hashString(name);
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function sortDecisions(decisions: ActionDecision[]): ActionDecision[] {
  return decisions.sort((left, right) => left.name.localeCompare(right.name));
}

function makeDecision(file: AuthFileItem, action: ActionDecision['action'], reason: string, probe?: Awaited<ReturnType<typeof probeAuth>>): ActionDecision {
  return {
    name: file.name,
    provider: String(file.provider ?? file.type ?? ''),
    auth_index: file.auth_index,
    action,
    reason,
    probe
  };
}

async function loadConfig(filePath: string): Promise<ConfigFile> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isObject(parsed)) throw new Error('config must be a JSON object');
    return parsed as ConfigFile;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return {};
    console.error(`Failed to load config ${filePath}: ${error?.message ?? error}`);
    process.exit(2);
  }
}

async function withRetries<T>(retries: number, fn: () => Promise<T>): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastErr = error;
      const wait = Math.min(2000 * Math.pow(2, attempt), 15_000);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, wait));
    }
  }
  throw lastErr;
}

function printHelp(defaultConfigPath: string): void {
  console.log(`Options:
  --help                        Show help
  --config                      Path to config file (default: ${defaultConfigPath})
  --base-url                    Management API base URL
  --management-key              Management key (or env MANAGEMENT_KEY)
  --concurrency                 Number of concurrent workers
  --retries                     Retry count for probe mode
  --disable-after-failures      Non-401 failures required before disable
  --dry-run                     true|false
  --output                      Report output path
  --only-provider               Provider filter, e.g. codex
  --include-disabled            true|false
  --mode                        status|probe|reconcile|recover
  --state-file                  Local state file path
  --probe-url                   Optional probe URL override
  --recover-after-successes     Successful probes required before enable
  --health-sample-rate          Fraction of healthy auths to probe each run
  --max-probe-candidates-per-run Maximum probe candidates per run
  --metrics-enabled             true|false
  --metrics-output              Prometheus textfile output path`);
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function hasShortFlag(argv: string[], name: string): boolean {
  return argv.includes(`-${name}`);
}

function getStringFlag(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === `--${name}`) return argv[i + 1];
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  return undefined;
}

function getNumberFlag(argv: string[], name: string, fallback: number): number {
  const value = getStringFlag(argv, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    console.error(`Invalid --${name}: ${value}`);
    process.exit(2);
  }
  return parsed;
}

function getFloatFlag(argv: string[], name: string, fallback: number): number {
  return getNumberFlag(argv, name, fallback);
}

function getBooleanFlag(argv: string[], name: string, fallback: boolean | undefined): boolean | undefined {
  const value = getStringFlag(argv, name);
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  console.error(`Invalid --${name}: ${value}. Use true or false.`);
  process.exit(2);
}

function getModeFlag(argv: string[], fallback: RunMode): RunMode {
  const value = getStringFlag(argv, 'mode');
  if (value === undefined) return fallback;
  if (value === 'status' || value === 'probe' || value === 'reconcile' || value === 'recover') return value;
  console.error(`Invalid --mode: ${value}. Use status, probe, reconcile, or recover.`);
  process.exit(2);
}

function normalizeMetricsConfig(
  configPath: string,
  input: Partial<MetricsConfig> | undefined,
  enabledOverride: boolean | undefined,
  outputOverride: string | undefined
): MetricsConfig {
  return {
    enabled: enabledOverride ?? input?.enabled ?? false,
    output: resolve(outputOverride ?? input?.output ?? resolve(configPath, '..', 'metrics.prom'))
  };
}

function normalizeStatus(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
