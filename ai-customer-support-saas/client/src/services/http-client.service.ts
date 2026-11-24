import { clientEnv } from '../config/env.config';
import type { ApiErrorPayload } from '../types/api.types';
import {
  blockTokenRefresh,
  clearAccessToken,
  getAccessToken,
  isTokenRefreshBlocked,
  notifyAuthFailure,
  setAccessToken,
} from './auth-token.store';

/**
 * Central HTTP client — the ONLY place that performs `fetch` for API data.
 *
 * Responsibilities:
 *  - URL building from `VITE_API_BASE_URL` + `/api/v1/...` paths.
 *  - Bearer access token injection (token lives in memory, see auth-token.store).
 *  - Per-request timeout via AbortController.
 *  - One transparent refresh-and-retry on 401 (single-flight, blocked after a
 *    failure) — no refresh loops, no thundering herd against the rate-limited
 *    `/auth/refresh` route.
 *  - Envelope handling: `{ success: true, data }` is unwrapped; raw legacy
 *    payloads (the `/health` probes) pass through unchanged.
 *  - Uniform `HttpApiError` for every failure the UI must render.
 */

/** Error thrown for every failed API response, normalized for the UI layer. */
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

  /** 401/403: the caller is not (or no longer) authorized. */
  public get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }

  public get isNetworkError(): boolean {
    return this.status === 0;
  }

  public get isNotFound(): boolean {
    return this.status === 404;
  }

  /** 422: field-level validation details are available. */
  public get isValidationError(): boolean {
    return this.status === 422;
  }
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  readonly method?: HttpMethod;
  readonly body?: unknown;
  /** Caller cancellation (component unmount, stale request). */
  readonly signal?: AbortSignal;
  /** Skips the transparent refresh-and-retry (auth refresh/logout calls). */
  readonly skipAuthRefresh?: boolean;
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
}

interface InternalRequestOptions extends RequestOptions {
  /** Set by the retry path so a request is retried at most once. */
  readonly hasRetried?: boolean;
}

function buildUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${clientEnv.apiOrigin}${path}`;
}

interface EnvelopeLike {
  success?: unknown;
  data?: unknown;
  accessToken?: unknown;
}

function isSuccessEnvelope(body: unknown): body is { success: true; data: unknown } {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as EnvelopeLike).success === true &&
    'data' in body
  );
}

/** Merges the caller signal with a timeout so both can abort the fetch. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const timer = window.setTimeout(() => {
    controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError'));
  }, timeoutMs);

  const onAbort = (): void => controller.abort(signal?.reason);
  if (signal !== undefined) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function send(path: string, options: InternalRequestOptions): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...options.headers,
  };

  const token = getAccessToken();
  if (token !== null) headers['Authorization'] = `Bearer ${token}`;

  const { signal, dispose } = withTimeout(options.signal, options.timeoutMs ?? clientEnv.requestTimeoutMs);

  try {
    return await fetch(buildUrl(path), {
      method: options.method ?? 'GET',
      headers,
      credentials: 'include',
      signal,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch (cause) {
    const abortedByCaller = options.signal?.aborted === true;
    if (abortedByCaller) throw cause;
    const timedOut = cause instanceof DOMException && cause.name === 'TimeoutError';
    throw new HttpApiError(
      timedOut ? 'The server took too long to respond. Please try again.' : 'Network unreachable. Check your connection and try again.',
      { status: 0, code: timedOut ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR', cause },
    );
  } finally {
    dispose();
  }
}

async function toApiError(response: Response): Promise<HttpApiError> {
  const payload = (await response.json().catch(() => null)) as ApiErrorPayload | null;
  const fallback =
    response.status === 401
      ? 'Your session has expired. Please sign in again.'
      : response.status === 403
        ? 'You do not have permission to perform this action.'
        : `Request failed with status ${response.status}`;

  return new HttpApiError(payload?.error?.message ?? fallback, {
    status: response.status,
    code: payload?.error?.code ?? 'UNKNOWN_ERROR',
    details: payload?.error?.details,
    requestId: payload?.requestId,
  });
}

let refreshPromise: Promise<boolean> | null = null;

/**
 * Tries to exchange the refresh cookie for a new access token exactly once at
 * a time. Returns false (never throws) when the session cannot be renewed.
 */
export function ensureFreshAccessToken(): Promise<boolean> {
  if (isTokenRefreshBlocked()) return Promise.resolve(false);
  if (refreshPromise !== null) return refreshPromise;

  const pending = (async (): Promise<boolean> => {
    try {
      const response = await send(clientEnv.authRefreshPath, {
        method: 'POST',
        skipAuthRefresh: true,
        hasRetried: true,
      });
      if (!response.ok) {
        blockTokenRefresh();
        return false;
      }
      const body = (await response.json().catch(() => null)) as EnvelopeLike | null;
      const token = isSuccessEnvelope(body) ? (body.data as { accessToken?: unknown }).accessToken : body?.accessToken;
      if (typeof token !== 'string' || token.length === 0) {
        blockTokenRefresh();
        return false;
      }
      setAccessToken(token);
      return true;
    } catch {
      blockTokenRefresh();
      return false;
    }
  })();

  refreshPromise = pending;
  void pending.finally(() => {
    if (refreshPromise === pending) refreshPromise = null;
  });
  return pending;
}

/**
 * Performs an API request and resolves with the response payload.
 * On 401 it refreshes once and retries once; a second 401 ends the session
 * (token cleared, auth-failure listeners notified) and throws.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const internal = options as InternalRequestOptions;
  let response = await send(path, internal);

  if (response.status === 401 && internal.skipAuthRefresh !== true && internal.hasRetried !== true) {
    const refreshed = await ensureFreshAccessToken();
    if (refreshed) {
      response = await send(path, { ...internal, hasRetried: true });
    }
  }

  if (!response.ok) {
    if (response.status === 401) {
      clearAccessToken();
      notifyAuthFailure();
    }
    throw await toApiError(response);
  }

  if (response.status === 204) return undefined as T;

  const body = (await response.json().catch(() => null)) as EnvelopeLike | null;
  return (isSuccessEnvelope(body) ? body.data : body) as T;
}

/** Thin typed wrapper used by every feature service. */
export const httpClient = {
  get<T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> {
    return apiRequest<T>(path, { ...options, method: 'GET' });
  },
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return apiRequest<T>(path, { ...options, method: 'POST', ...(body !== undefined ? { body } : {}) });
  },
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return apiRequest<T>(path, { ...options, method: 'PUT', ...(body !== undefined ? { body } : {}) });
  },
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return apiRequest<T>(path, { ...options, method: 'PATCH', ...(body !== undefined ? { body } : {}) });
  },
  delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return apiRequest<T>(path, { ...options, method: 'DELETE' });
  },
};
