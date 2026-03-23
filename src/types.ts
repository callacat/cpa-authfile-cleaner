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
  [k: string]: unknown;
};

export type AuthFilesResponse = { files: AuthFileItem[]; total?: number };

export type ApiCallPayload = {
  auth_index: number | string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  header?: Record<string, string>;
  data?: unknown;
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
  | { ok: true }
  | { ok: false; status?: number; status401: boolean; raw: unknown };

export type DeleteDecision = {
  name: string;
  provider?: string;
  auth_index?: number | string;
  reason: string;
  probe?: ProbeResult;
};
