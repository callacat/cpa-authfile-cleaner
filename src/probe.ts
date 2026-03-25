import type { ApiCallPayload, ProbeFailureKind, ProbeResult, StructuredErrorLike } from './types.js';
import { HttpClient } from './http.js';

export const DEFAULT_PROBE_URL = 'https://api.openai.com/v1/models';

export async function shouldForceProbeUrl(client: HttpClient, authIndex: number | string): Promise<boolean> {
  const payload = buildProbePayload(authIndex);

  try {
    await client.json('POST', '/api-call', payload);
    return false;
  } catch (err: any) {
    return isMissingUrlError(err);
  }
}

export async function probeAuth(
  client: HttpClient,
  authIndex: number | string,
  provider?: string,
  probeUrl?: string
): Promise<ProbeResult> {
  const payload = buildProbePayload(authIndex, probeUrl);

  const startedAt = Date.now();

  try {
    // management endpoint is /api-call
    const result = await client.json<unknown>('POST', '/api-call', payload);
    return parseProbeSuccess(result, Date.now() - startedAt);
  } catch (err: any) {
    const raw = err?.data ?? err;
    return parseProbeFailure(err, raw, Date.now() - startedAt);
  }
}

function buildProbePayload(authIndex: number | string, probeUrl?: string): ApiCallPayload {
  return {
    auth_index: authIndex,
    method: 'GET',
    ...(probeUrl ? { url: probeUrl } : {}),
    header: {
      // placeholder; server-side tool will substitute/forward if needed
      'User-Agent': 'cpa-authfile-cleaner'
    }
  };
}

function isMissingUrlError(error: unknown): boolean {
  if (normalizeStatus((error as { status?: unknown } | undefined)?.status) !== 400) return false;
  return describeErrorPayload((error as { data?: unknown } | undefined)?.data ?? error).includes('missing url');
}

function parseProbeSuccess(result: unknown, durationMs: number): ProbeResult {
  const outerStatus = 200;
  const upstreamStatus = extractUpstreamStatus(result);
  const reason = extractFailureReason(result);

  if (upstreamStatus === 401) {
    return buildFailure({
      durationMs,
      raw: result,
      outerStatus,
      upstreamStatus,
      failureKind: 'upstream_401',
      reason: reason ?? 'upstream status 401',
      errorKind: 'http'
    });
  }

  if (isQuotaExceeded(result)) {
    return buildFailure({
      durationMs,
      raw: result,
      outerStatus,
      upstreamStatus,
      failureKind: 'upstream_quota',
      reason: reason ?? 'upstream quota exceeded',
      errorKind: 'http'
    });
  }

  if (isRateLimited(result) || upstreamStatus === 429) {
    return buildFailure({
      durationMs,
      raw: result,
      outerStatus,
      upstreamStatus: upstreamStatus ?? 429,
      failureKind: 'upstream_rate_limit',
      reason: reason ?? 'upstream rate limited',
      errorKind: 'http'
    });
  }

  if (upstreamStatus !== undefined && upstreamStatus >= 400) {
    return buildFailure({
      durationMs,
      raw: result,
      outerStatus,
      upstreamStatus,
      failureKind: 'upstream_http',
      reason: reason ?? `upstream status ${upstreamStatus}`,
      errorKind: 'http'
    });
  }

  return {
    ok: true,
    status: upstreamStatus ?? outerStatus,
    outerStatus,
    upstreamStatus,
    durationMs
  };
}

function parseProbeFailure(error: unknown, raw: unknown, durationMs: number): ProbeResult {
  const outerStatus = normalizeStatus((error as { status?: unknown } | undefined)?.status);
  const upstreamStatus = extractUpstreamStatus(raw);
  const errorKind = classifyError(error);
  const reason = extractFailureReason(raw) ?? (outerStatus !== undefined ? `management status ${outerStatus}` : `probe failed kind=${errorKind}`);

  if (upstreamStatus === 401) {
    return buildFailure({ durationMs, raw, outerStatus, upstreamStatus, failureKind: 'upstream_401', reason, errorKind: 'http' });
  }
  if (isQuotaExceeded(raw)) {
    return buildFailure({ durationMs, raw, outerStatus, upstreamStatus, failureKind: 'upstream_quota', reason, errorKind: 'http' });
  }
  if (isRateLimited(raw) || upstreamStatus === 429) {
    return buildFailure({ durationMs, raw, outerStatus, upstreamStatus: upstreamStatus ?? 429, failureKind: 'upstream_rate_limit', reason, errorKind: 'http' });
  }
  if (upstreamStatus !== undefined && upstreamStatus >= 400) {
    return buildFailure({ durationMs, raw, outerStatus, upstreamStatus, failureKind: 'upstream_http', reason, errorKind: 'http' });
  }
  if (outerStatus !== undefined) {
    return buildFailure({ durationMs, raw, outerStatus, upstreamStatus, failureKind: 'management_http', reason, errorKind });
  }
  return buildFailure({ durationMs, raw, outerStatus, upstreamStatus, failureKind: errorKind === 'timeout' ? 'timeout' : errorKind === 'network' ? 'network' : 'unknown', reason, errorKind });
}

function buildFailure(input: {
  durationMs: number;
  raw: unknown;
  outerStatus?: number;
  upstreamStatus?: number;
  failureKind: ProbeFailureKind;
  reason: string;
  errorKind: 'http' | 'network' | 'timeout' | 'unknown';
}): ProbeResult {
  const status = input.upstreamStatus ?? input.outerStatus;
  return {
    ok: false,
    status,
    outerStatus: input.outerStatus,
    upstreamStatus: input.upstreamStatus,
    status401: input.failureKind === 'upstream_401' || status === 401,
    rateLimited: input.failureKind === 'upstream_rate_limit' || status === 429,
    quotaExceeded: input.failureKind === 'upstream_quota',
    raw: input.raw,
    durationMs: input.durationMs,
    errorKind: input.errorKind,
    failureKind: input.failureKind,
    reason: input.reason
  };
}

function extractUpstreamStatus(value: unknown): number | undefined {
  if (!isObject(value)) return undefined;
  const direct = normalizeStatus(value.status_code ?? value.status ?? value.code);
  if (direct !== undefined) return direct;
  const body = parseNestedBody(value.body);
  if (!body) return undefined;
  const nestedErrorStatus = isObject(body.error) ? body.error.status : undefined;
  return normalizeStatus(body.status ?? (body as Record<string, unknown>).status_code ?? body.code ?? nestedErrorStatus);
}

function extractFailureReason(value: unknown): string | undefined {
  const messages = collectErrorStrings(value);
  return messages.find(Boolean);
}

function collectErrorStrings(value: unknown): string[] {
  const out: string[] = [];
  walkErrorLike(value, (item) => {
    const candidates = [item.message, item.error_description, item.error?.message, item.error?.type, item.error?.code, item.code];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) out.push(candidate.trim());
    }
  });
  return out;
}

function isQuotaExceeded(value: unknown): boolean {
  const text = describeErrorPayload(value);
  return text.includes('insufficient_quota') || text.includes('quota exceeded') || text.includes('quota limit') || text.includes('billing');
}

function isRateLimited(value: unknown): boolean {
  const text = describeErrorPayload(value);
  return text.includes('rate limit') || text.includes('too many requests');
}

function parseNestedBody(value: unknown): StructuredErrorLike | null {
  if (!isObject(value) || typeof value.body !== 'string') return null;
  try {
    const parsed = JSON.parse(value.body);
    return isObject(parsed) ? (parsed as StructuredErrorLike) : null;
  } catch {
    return null;
  }
}

function walkErrorLike(value: unknown, visit: (item: Record<string, any>) => void): void {
  const queue: unknown[] = [value];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!isObject(current) || seen.has(current)) continue;
    seen.add(current);
    visit(current);
    if (isObject(current.error)) queue.push(current.error);
    if (isObject(current.data)) queue.push(current.data);
    const nestedBody = parseNestedBody(current);
    if (nestedBody) queue.push(nestedBody);
  }
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

function describeErrorPayload(value: unknown): string {
  if (typeof value === 'string') return value.toLowerCase();
  try {
    return JSON.stringify(value).toLowerCase();
  } catch {
    return String(value ?? '').toLowerCase();
  }
}

function normalizeStatus(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function classifyError(error: unknown): 'http' | 'network' | 'timeout' | 'unknown' {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? '').toLowerCase();
  if (message.includes('abort') || message.includes('timeout')) return 'timeout';
  if (message.includes('fetch') || message.includes('network') || message.includes('socket')) return 'network';
  if (normalizeStatus((error as { status?: unknown } | undefined)?.status) !== undefined) return 'http';
  return 'unknown';
}
