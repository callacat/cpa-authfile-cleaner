import type { AuthFileStatusPayload } from './types.js';

export type HttpClientOptions = {
  baseUrl: string; // e.g. https://host/v0/management
  managementKey: string;
  timeoutMs?: number;
};

export class HttpClient {
  constructor(private opts: HttpClientOptions) {}

  private url(path: string): string {
    const base = this.opts.baseUrl.replace(/\/$/, '');
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${base}${p}`;
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 30_000);

    try {
      const res = await fetch(this.url(path), {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          authorization: `Bearer ${this.opts.managementKey}`
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });

      const text = await res.text();
      const maybeJson = text ? safeJson(text) : null;

      if (res.status < 200 || res.status >= 300) {
        const err: any = new Error(
          (maybeJson && (maybeJson.error?.message || maybeJson.message || maybeJson.error)) || `HTTP ${res.status}`
        );
        err.status = res.status;
        err.data = maybeJson ?? text;
        throw err;
      }

      return (maybeJson ?? (text as any)) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async setAuthDisabled(payload: AuthFileStatusPayload): Promise<void> {
    await this.json('PATCH', '/auth-files/status', payload);
  }
}

function safeJson(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
