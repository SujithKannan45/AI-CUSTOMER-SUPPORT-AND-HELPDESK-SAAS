import { clientEnv } from '../config/env.config';
import type { ApiErrorPayload } from '../types/api.types';

/** Error thrown for every non-2xx API response, normalized for the UI layer. */
export class HttpApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: unknown;
  public readonly requestId?: string;

  public constructor(
    message: string,
    options: { status: number; code: string; details?: unknown; requestId?: string; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = 'HttpApiError';
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.requestId = options.requestId;
  }

  public get isAuthError(): boolean {
    return this.status === 401;
  }
}

function buildUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${clientEnv.apiBaseUrl}${path}`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(buildUrl(path), {
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
      ...init,
    });
  } catch (cause) {
    throw new HttpApiError('Network unreachable. Check your connection and try again.', {
      status: 0,
      code: 'NETWORK_ERROR',
      cause,
    });
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ApiErrorPayload | null;
    throw new HttpApiError(payload?.error.message ?? `Request failed with status ${response.status}`, {
      status: response.status,
      code: payload?.error.code ?? 'UNKNOWN_ERROR',
      details: payload?.error.details,
      requestId: payload?.requestId,
    });
  }

  return (await response.json()) as T;
}

/** Thin typed wrapper over fetch used by every feature service. */
export const httpClient = {
  get<T>(path: string): Promise<T> {
    return request<T>(path, { method: 'GET' });
  },
  post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
  },
  put<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) });
  },
  patch<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) });
  },
  delete<T>(path: string): Promise<T> {
    return request<T>(path, { method: 'DELETE' });
  },
};
