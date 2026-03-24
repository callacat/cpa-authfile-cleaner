import type { ApiCallPayload, ProbeResult } from './types.js';
import { HttpClient } from './http.js';

export async function probeAuth(
  client: HttpClient,
  authIndex: number | string,
  provider?: string,
  probeUrl?: string
): Promise<ProbeResult> {
  const payload: ApiCallPayload = {
    auth_index: authIndex,
    method: 'GET',
    ...(probeUrl ? { url: probeUrl } : {}),
    header: {
      // placeholder; server-side tool will substitute/forward if needed
      'User-Agent': 'cpa-authfile-cleaner'
    }
  };

  const startedAt = Date.now();

  try {
    // management endpoint is /api-call
    await client.json('POST', '/api-call', payload);
    return { ok: true, status: 200, durationMs: Date.now() - startedAt };
  } catch (err: any) {
    const status = normalizeStatus(err?.status);
    const raw = err?.data ?? err;
    const status401 = status === 401;
    return {
      ok: false,
      status,
      status401,
      raw,
      durationMs: Date.now() - startedAt,
      errorKind: classifyError(err)
    };
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
