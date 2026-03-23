#!/usr/bin/env node
import pLimit from 'p-limit';
import { HttpClient } from './http.js';
import type { AuthFileItem, AuthFilesResponse, DeleteDecision, StructuredErrorLike } from './types.js';
import { probeAuth } from './probe.js';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function shouldDeleteByStatusMessage(f: AuthFileItem): boolean {
  const runtimeStatus = normalizeString(f.status);
  if (runtimeStatus && runtimeStatus !== 'error') return false;

  const parsed = parseStatusMessage(f.status_message ?? f.statusMessage);
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

    const obj = current as StructuredErrorLike;
    const status = normalizeStatus(obj.status);

    if (status === 401) {
      return true;
    }

    if (isObject(obj.error)) queue.push(obj.error);
    if (isObject(obj.details)) queue.push(obj.details);
    if (isObject(obj.data)) queue.push(obj.data);
  }

  return false;
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

type Args = {
  config: string;
  baseUrl: string;
  managementKey?: string;
  concurrency: number;
  retries: number;
  dryRun: boolean;
  output?: string;
  onlyProvider?: string;
  includeDisabled: boolean;
  mode: 'status' | 'probe';
};

type ConfigFile = Partial<{
  baseUrl: string;
  managementKey: string;
  concurrency: number;
  retries: number;
  dryRun: boolean;
  output: string;
  onlyProvider: string;
  includeDisabled: boolean;
  mode: 'status' | 'probe';
}>;

void main().catch((error: any) => {
  console.error(error?.message ?? error);
  process.exit(1);
});

async function main(): Promise<void> {
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

  const args: Args = {
    config: configPath,
    baseUrl,
    managementKey: getStringFlag(rawArgv, 'management-key') ?? fileConfig.managementKey,
    concurrency: getNumberFlag(rawArgv, 'concurrency', fileConfig.concurrency ?? 2),
    retries: getNumberFlag(rawArgv, 'retries', fileConfig.retries ?? 0),
    dryRun: getBooleanFlag(rawArgv, 'dry-run', fileConfig.dryRun ?? true),
    output: getStringFlag(rawArgv, 'output') ?? fileConfig.output ?? 'report.json',
    onlyProvider: getStringFlag(rawArgv, 'only-provider') ?? fileConfig.onlyProvider,
    includeDisabled: getBooleanFlag(rawArgv, 'include-disabled', fileConfig.includeDisabled ?? false),
    mode: getModeFlag(rawArgv, fileConfig.mode ?? 'status')
  };

  const key = args.managementKey ?? process.env.MANAGEMENT_KEY ?? process.env.CPA_MANAGEMENT_KEY;
  if (!key) {
    console.error(`Missing management key. Set it in ${configPath}, pass --management-key, or export MANAGEMENT_KEY`);
    process.exit(2);
  }

  const client = new HttpClient({ baseUrl: args.baseUrl, managementKey: key });

  const list = await client.json<AuthFilesResponse>('GET', '/auth-files');
  let files = list.files ?? [];

  if (args.onlyProvider) {
    const p = args.onlyProvider.toLowerCase();
    files = files.filter((f) => String(f.provider ?? f.type ?? '').toLowerCase() === p);
  }
  if (!args.includeDisabled) {
    files = files.filter((f) => !f.disabled);
  }

  const limit = pLimit(Math.max(1, args.concurrency));
  const decisions: DeleteDecision[] = [];

  await Promise.all(
    files.map((f) =>
      limit(async () => {
        const authIndex = f.auth_index;
        if (authIndex === undefined || authIndex === null || authIndex === '') {
          decisions.push({ name: f.name, provider: String(f.provider ?? f.type ?? ''), reason: 'skip: missing auth_index' });
          return;
        }

        const provider = String(f.provider ?? f.type ?? '');

        if (args.mode === 'status') {
          const hit = shouldDeleteByStatusMessage(f);
          if (hit) {
            decisions.push({
              name: f.name,
              provider,
              auth_index: authIndex,
              reason: 'delete: status_message confirms status 401'
            });
            if (!args.dryRun) {
              await client.json('DELETE', `/auth-files?name=${encodeURIComponent(f.name)}`);
            }
            return;
          }

          decisions.push({
            name: f.name,
            provider,
            auth_index: authIndex,
            reason: 'keep: status_message does not prove status 401'
          });
          return;
        }

        const probe = await withRetries(args.retries, async () => probeAuth(client, authIndex, provider));
        if (!probe.ok && probe.status401) {
          decisions.push({
            name: f.name,
            provider,
            auth_index: authIndex,
            reason: 'delete: status 401 (probe)',
            probe
          });
          if (!args.dryRun) {
            await client.json('DELETE', `/auth-files?name=${encodeURIComponent(f.name)}`);
          }
          return;
        }

        decisions.push({
          name: f.name,
          provider,
          auth_index: authIndex,
          reason: probe.ok ? 'keep: probe ok' : `keep: probe failed (status=${probe.status ?? 'n/a'})`,
          probe
        });
      })
    )
  );

  const deleted = decisions.filter((d) => d.reason.startsWith('delete:'));
  const kept = decisions.length - deleted.length;
  const report = {
    at: new Date().toISOString(),
    config: configPath,
    baseUrl: args.baseUrl,
    dryRun: args.dryRun,
    total: decisions.length,
    deleted: deleted.length,
    kept,
    items: decisions
  };

  console.log(`total=${report.total} delete=${report.deleted} keep=${report.kept} dryRun=${report.dryRun}`);
  for (const d of deleted) console.log(`DELETE ${d.name} (${d.provider ?? ''})`);

  if (args.output) {
    await writeFile(args.output, JSON.stringify(report, null, 2), 'utf8');
    console.log(`report written: ${args.output}`);
  }
}

async function loadConfig(filePath: string): Promise<ConfigFile> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isObject(parsed)) {
      throw new Error('config must be a JSON object');
    }
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
    } catch (e) {
      lastErr = e;
      const wait = Math.min(2000 * Math.pow(2, attempt), 15_000);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

function printHelp(defaultConfigPath: string): void {
  console.log(`Options:
  --help              Show help
  --config            Path to config file (default: ${defaultConfigPath})
  --base-url          Management API base URL, e.g. http://127.0.0.1:8080/v0/management
  --management-key    Management key (or env MANAGEMENT_KEY)
  --concurrency       Number of concurrent workers
  --retries           Retry count for probe mode
  --dry-run           true|false
  --output            Report output path
  --only-provider     Provider filter, e.g. codex
  --include-disabled  true|false
  --mode              status|probe`);
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

function getBooleanFlag(argv: string[], name: string, fallback: boolean): boolean {
  const value = getStringFlag(argv, name);
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  console.error(`Invalid --${name}: ${value}. Use true or false.`);
  process.exit(2);
}

function getModeFlag(argv: string[], fallback: 'status' | 'probe'): 'status' | 'probe' {
  const value = getStringFlag(argv, 'mode');
  if (value === undefined) return fallback;
  if (value === 'status' || value === 'probe') return value;
  console.error(`Invalid --mode: ${value}. Use status or probe.`);
  process.exit(2);
}
