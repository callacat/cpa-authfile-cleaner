export type AuthFileItem = {
  id?: string;
  auth_index?: number | string;
  name: string;
  type?: string;
  provider?: string;
  status?: string;
  status_message?: string;
  statusMessage?: string;
  disabled?: boolean;
  unavailable?: boolean;
  runtime_only?: boolean;
  proxy_url?: string;
  note?: string;
  [k: string]: unknown;
};

export type AuthFilesResponse = { files: AuthFileItem[]; total?: number };

export type ApiCallPayload = {
  auth_index: number | string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url?: string;
  header?: Record<string, string>;
  data?: unknown;
};

export type AuthFileStatusPayload = {
  name: string;
  disabled: boolean;
};

export type StructuredErrorLike = {
  status?: number | string;
  code?: string;
  error?: unknown;
  message?: string;
  details?: unknown;
  data?: unknown;
  [k: string]: unknown;
};

export type ApiErrorShape = StructuredErrorLike;

export type ProbeResult =
  | { ok: true; status?: number; durationMs: number }
  | {
      ok: false;
      status?: number;
      status401: boolean;
      raw: unknown;
      durationMs: number;
      errorKind: 'http' | 'network' | 'timeout' | 'unknown';
    };

export type DecisionAction = 'keep' | 'delete' | 'disable' | 'enable' | 'skip';

export type ActionDecision = {
  name: string;
  provider?: string;
  auth_index?: number | string;
  action: DecisionAction;
  reason: string;
  probe?: ProbeResult;
};

export type LegacyMode = 'status' | 'probe';
export type RunMode = LegacyMode | 'reconcile' | 'recover';

export type ManagedAction = 'none' | 'disabled' | 'deleted';

export type AuthStateEntry = {
  name: string;
  authIndex?: number | string;
  provider?: string;
  managedByTool: boolean;
  originalDisabled: boolean;
  currentAction: ManagedAction;
  disableReason?: string;
  lastProbeStatus?: number;
  lastProbeOk?: boolean;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  lastCheckedAt?: string;
  lastFailedAt?: string;
  lastDisabledAt?: string;
  lastEnabledAt?: string;
  lastDeletedAt?: string;
  backoffUntil?: string;
};

export type AuthStateFile = {
  version: 1;
  updatedAt: string;
  entries: Record<string, AuthStateEntry>;
};

export type LoadedState = {
  state: AuthStateFile;
  normalized: boolean;
  recovered: boolean;
  backupPath?: string;
};

export type MetricsConfig = {
  enabled: boolean;
  output: string;
};

export type CandidateKind = 'suspicious' | 'managed-disabled' | 'healthy-sample' | 'legacy-all';

export type RunMetrics = {
  seenTotal: number;
  deletedTotal: number;
  disabledTotal: number;
  enabledTotal: number;
  keptTotal: number;
  skippedTotal: number;
  prunedStateEntriesTotal: number;
  stateChanged: number;
  stateNormalized: number;
  stateRecovered: number;
  probeTotal: number;
  probeOkTotal: number;
  probeStatus401Total: number;
  probeFailedTotal: number;
  probeDurationSecondsSum: number;
  stateSaveDurationSeconds: number;
  managedDisabled: number;
  stateEntries: number;
  suspiciousCandidates: number;
  managedDisabledCandidates: number;
  healthySampleCandidates: number;
  errorsTotal: number;
  runDurationSeconds: number;
  runTimestampSeconds: number;
};
