import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { AuthStateEntry, AuthStateFile, LoadedState, ManagedAction } from './types.js';

const EMPTY_STATE: AuthStateFile = {
  version: 1,
  updatedAt: new Date(0).toISOString(),
  entries: {}
};

export async function loadState(filePath: string): Promise<LoadedState> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const normalized = normalizeStateFile(parsed);
    if (!normalized) {
      const backupPath = await recoverBrokenStateFile(filePath, 'invalid');
      return { state: structuredClone(EMPTY_STATE), normalized: false, recovered: true, backupPath };
    }
    const comparableRaw = serializeUnknownComparableState(parsed);
    const comparableNormalized = serializeComparableState(normalized);
    return {
      state: normalized,
      normalized: comparableRaw !== comparableNormalized,
      recovered: false
    };
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return { state: structuredClone(EMPTY_STATE), normalized: false, recovered: false };
    }
    if (error instanceof SyntaxError) {
      const backupPath = await recoverBrokenStateFile(filePath, 'broken');
      return { state: structuredClone(EMPTY_STATE), normalized: false, recovered: true, backupPath };
    }
    throw error;
  }
}

export async function saveState(filePath: string, state: AuthStateFile, previousState?: AuthStateFile): Promise<boolean> {
  const nextState = buildPersistedState(state, new Date().toISOString());

  if (previousState && serializeComparableState(previousState) === serializeComparableState(nextState)) {
    return false;
  }

  const tempPath = join(dirname(filePath), `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  try {
    await writeFile(tempPath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }

  state.updatedAt = nextState.updatedAt;
  state.entries = nextState.entries;
  return true;
}

export function hasStateChanged(previousState: AuthStateFile, nextState: AuthStateFile): boolean {
  return serializeComparableState(previousState) !== serializeComparableState(nextState);
}

export function compactState(state: AuthStateFile, activeNames: Iterable<string>): number {
  const active = new Set(activeNames);
  let removed = 0;

  for (const [name, entry] of Object.entries(state.entries)) {
    if (active.has(name)) continue;
    if (entry.currentAction === 'disabled') continue;
    delete state.entries[name];
    removed += 1;
  }

  return removed;
}

export function getStateEntry(state: AuthStateFile, name: string): AuthStateEntry | undefined {
  return state.entries[name];
}

export function upsertStateEntry(state: AuthStateFile, entry: AuthStateEntry): void {
  state.entries[entry.name] = entry;
}

export function createDefaultEntry(
  name: string,
  input: Pick<AuthStateEntry, 'authIndex' | 'provider' | 'originalDisabled'>
): AuthStateEntry {
  return {
    name,
    authIndex: input.authIndex,
    provider: input.provider,
    managedByTool: false,
    originalDisabled: input.originalDisabled,
    currentAction: 'none',
    consecutiveSuccesses: 0,
    consecutiveFailures: 0
  };
}

function normalizeStateFile(value: unknown): AuthStateFile | null {
  if (!isObject(value)) return null;
  if (value.version !== 1) return null;
  if (!isObject(value.entries)) return null;
  return {
    version: 1,
    updatedAt: normalizeOptionalString(value.updatedAt) ?? EMPTY_STATE.updatedAt,
    entries: buildNormalizedEntries(value.entries)
  };
}

function serializeComparableState(state: AuthStateFile): string {
  return JSON.stringify({
    version: 1,
    entries: buildNormalizedEntries(state.entries)
  });
}

function serializeUnknownComparableState(value: unknown): string {
  const normalized = normalizeStateFile(value);
  if (!normalized) return 'invalid';
  return serializeComparableState(normalized);
}

function buildPersistedState(state: AuthStateFile, updatedAt: string): AuthStateFile {
  return {
    version: 1,
    updatedAt,
    entries: buildNormalizedEntries(state.entries)
  };
}

function buildNormalizedEntries(entries: Record<string, unknown>): Record<string, AuthStateEntry> {
  return Object.fromEntries(
    Object.entries(entries)
      .filter(([, entry]) => isObject(entry))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entry]) => [name, normalizeStateEntry(name, entry as Record<string, unknown>)])
  );
}

function normalizeStateEntry(name: string, value: Record<string, unknown>): AuthStateEntry {
  return {
    name,
    authIndex: normalizeAuthIndex(value.authIndex),
    provider: normalizeOptionalString(value.provider),
    managedByTool: Boolean(value.managedByTool),
    originalDisabled: Boolean(value.originalDisabled),
    currentAction: normalizeManagedAction(value.currentAction),
    disableReason: normalizeOptionalString(value.disableReason),
    lastProbeStatus: normalizeOptionalNumber(value.lastProbeStatus),
    lastProbeOk: typeof value.lastProbeOk === 'boolean' ? value.lastProbeOk : undefined,
    consecutiveSuccesses: normalizeCounter(value.consecutiveSuccesses),
    consecutiveFailures: normalizeCounter(value.consecutiveFailures),
    lastCheckedAt: normalizeOptionalString(value.lastCheckedAt),
    lastFailedAt: normalizeOptionalString(value.lastFailedAt),
    lastDisabledAt: normalizeOptionalString(value.lastDisabledAt),
    lastEnabledAt: normalizeOptionalString(value.lastEnabledAt),
    lastDeletedAt: normalizeOptionalString(value.lastDeletedAt),
    backoffUntil: normalizeOptionalString(value.backoffUntil)
  };
}

function normalizeManagedAction(value: unknown): ManagedAction {
  return value === 'disabled' || value === 'deleted' ? value : 'none';
}

function normalizeAuthIndex(value: unknown): number | string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  return undefined;
}

function normalizeCounter(value: unknown): number {
  const normalized = normalizeOptionalNumber(value);
  if (normalized === undefined || normalized < 0) return 0;
  return Math.floor(normalized);
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

async function recoverBrokenStateFile(filePath: string, suffix: 'broken' | 'invalid'): Promise<string> {
  const backupPath = join(dirname(filePath), `${basename(filePath)}.${suffix}.${Date.now()}.json`);
  await rename(filePath, backupPath).catch(async (error: any) => {
    if (error?.code === 'ENOENT') return;
    throw error;
  });
  return backupPath;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
