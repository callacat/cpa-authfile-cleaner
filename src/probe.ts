import type { ApiCallPayload, ProbeResult } from './types.js';
import { HttpClient } from './http.js';

// Prefer a cheap endpoint that is broadly supported.
// For "openai compat" (codex/claude via proxy), /v1/models is typically safe.
const DEFAULT_PROBE_URL = 'https://api.openai.com/v1/models';

export async function probeAuth(
  client: HttpClient,
  authIndex: number | string,
  provider?: string
): Promise<ProbeResult> {
  const payload: ApiCallPayload = {
    auth_index: authIndex,
    method: 'GET',
    url: DEFAULT_PROBE_URL,
    header: {
      // placeholder; server-side tool will substitute/forward if needed
      'User-Agent': 'cpa-authfile-cleaner'
    }
  };

  try {
    // management endpoint is /api-call
    await client.json('POST', '/api-call', payload);
    return { ok: true };
  } catch (err: any) {
    const status = normalizeStatus(err?.status);
    const raw = err?.data ?? err;
    const status401 = status === 401;
    return { ok: false, status, status401, raw };
  }
}

function normalizeStatus(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}
