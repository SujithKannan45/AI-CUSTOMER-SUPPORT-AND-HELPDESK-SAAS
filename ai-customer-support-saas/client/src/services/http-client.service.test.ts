import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, HttpApiError } from './http-client.service';
import {
  clearAccessToken,
  getAccessToken,
  setAccessToken,
  subscribeToAuthFailure,
  unblockTokenRefresh,
} from './auth-token.store';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function authorizationOf(init?: RequestInit): string | null {
  return new Headers(init?.headers).get('Authorization');
}

function stubFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Response) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    Promise.resolve(handler(input, init)),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

interface FetchMockLike {
  readonly mock: { readonly calls: ReadonlyArray<readonly [RequestInfo | URL, RequestInit?]> };
}

function refreshCallCount(fetchMock: FetchMockLike): number {
  return fetchMock.mock.calls.filter(([input]) => urlOf(input).includes('/auth/refresh')).length;
}

describe('apiRequest', () => {
  beforeEach(() => {
    clearAccessToken();
    unblockTokenRefresh();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('unwraps the success envelope', async () => {
    stubFetch(() => jsonResponse({ success: true, data: { user: { id: 'user-1' } }, requestId: 'req-1' }));

    const payload = await apiRequest<{ user: { id: string } }>('/api/v1/auth/me');

    expect(payload).toEqual({ user: { id: 'user-1' } });
  });

  it('passes through un-enveloped responses such as the health probe', async () => {
    stubFetch(() => jsonResponse({ success: true, status: 'ok', services: { api: 'up' } }));

    const payload = await apiRequest<{ status: string }>('/health');

    expect(payload.status).toBe('ok');
  });

  it('attaches the in-memory access token as a bearer header', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ success: true, data: { ok: true } }));
    setAccessToken('token-abc');

    await apiRequest('/api/v1/tickets');

    expect(authorizationOf(fetchMock.mock.calls[0]?.[1])).toBe('Bearer token-abc');
  });

  it('maps error envelopes to HttpApiError with status, code and details', async () => {
    stubFetch(() =>
      jsonResponse(
        {
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: { email: ['Invalid'] } },
          requestId: 'req-9',
        },
        422,
      ),
    );

    const error = await apiRequest('/api/v1/customers').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpApiError);
    expect(error).toMatchObject({
      status: 422,
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      requestId: 'req-9',
    });
    expect((error as HttpApiError).isValidationError).toBe(true);
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    const fetchMock = stubFetch((input, init) => {
      if (urlOf(input).includes('/auth/refresh')) {
        return jsonResponse({ success: true, data: { accessToken: 'fresh-token' } });
      }
      return authorizationOf(init) === 'Bearer fresh-token'
        ? jsonResponse({ success: true, data: { ok: true } })
        : jsonResponse({ success: false, error: { code: 'UNAUTHORIZED', message: 'Session expired' } }, 401);
    });

    const payload = await apiRequest<{ ok: boolean }>('/api/v1/tickets');

    expect(payload).toEqual({ ok: true });
    expect(getAccessToken()).toBe('fresh-token');
    expect(refreshCallCount(fetchMock)).toBe(1);
  });

  it('shares a single refresh between concurrent 401 responses', async () => {
    const fetchMock = stubFetch((input, init) => {
      if (urlOf(input).includes('/auth/refresh')) {
        return jsonResponse({ success: true, data: { accessToken: 'shared-token' } });
      }
      return authorizationOf(init) === 'Bearer shared-token'
        ? jsonResponse({ success: true, data: { ok: true } })
        : jsonResponse({ success: false, error: { code: 'UNAUTHORIZED', message: 'Session expired' } }, 401);
    });

    const results = await Promise.all([
      apiRequest<{ ok: boolean }>('/api/v1/tickets'),
      apiRequest<{ ok: boolean }>('/api/v1/customers'),
    ]);

    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(refreshCallCount(fetchMock)).toBe(1);
  });

  it('stops refreshing after a failure instead of looping', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ success: false, error: { code: 'UNAUTHORIZED', message: 'Session expired' } }, 401),
    );

    const failures = vi.fn();
    const unsubscribe = subscribeToAuthFailure(failures);

    await expect(apiRequest('/api/v1/tickets')).rejects.toBeInstanceOf(HttpApiError);
    expect(refreshCallCount(fetchMock)).toBe(1);
    expect(failures).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).toBeNull();

    await expect(apiRequest('/api/v1/customers')).rejects.toBeInstanceOf(HttpApiError);
    expect(refreshCallCount(fetchMock)).toBe(1);

    unsubscribe();
  });

  it('never refreshes for calls that opt out (logout)', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ success: false, error: { code: 'UNAUTHORIZED', message: 'No session' } }, 401),
    );

    await expect(
      apiRequest('/api/v1/auth/logout', { method: 'POST', skipAuthRefresh: true }),
    ).rejects.toBeInstanceOf(HttpApiError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refreshCallCount(fetchMock)).toBe(0);
  });

  it('reports transport failures as network errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    const error = (await apiRequest('/api/v1/tickets').catch((caught: unknown) => caught)) as HttpApiError;

    expect(error).toBeInstanceOf(HttpApiError);
    expect(error.status).toBe(0);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.isNetworkError).toBe(true);
  });
});
