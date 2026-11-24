import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authService } from './auth.service';
import { useSessionStore } from './auth.store';
import { HttpApiError } from '@/services/http-client.service';
import { getAccessToken, setAccessToken } from '@/services/auth-token.store';
import { makeSessionPayload, resetAuthStores, TEST_USER } from '@/test/fixtures';

describe('session store', () => {
  beforeEach(() => {
    resetAuthStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('bootstraps an authenticated session from /auth/me', async () => {
    vi.spyOn(authService, 'getCurrentUser').mockResolvedValue(TEST_USER);

    await useSessionStore.getState().bootstrap();

    expect(useSessionStore.getState().status).toBe('authenticated');
    expect(useSessionStore.getState().user).toEqual(TEST_USER);
  });

  it('treats a rejected session as signed out, not as an error', async () => {
    vi.spyOn(authService, 'getCurrentUser').mockRejectedValue(
      new HttpApiError('Authentication required', { status: 401, code: 'UNAUTHORIZED' }),
    );

    await useSessionStore.getState().bootstrap();

    expect(useSessionStore.getState().status).toBe('anonymous');
    expect(useSessionStore.getState().error).toBeNull();
  });

  it('surfaces an unreachable API without pretending the user signed out', async () => {
    vi.spyOn(authService, 'getCurrentUser').mockRejectedValue(
      new HttpApiError('Network unreachable.', { status: 0, code: 'NETWORK_ERROR' }),
    );

    await useSessionStore.getState().bootstrap();

    expect(useSessionStore.getState().status).toBe('error');
    expect(useSessionStore.getState().error).toBe('Network unreachable.');
  });

  it('keeps the access token in memory only', () => {
    useSessionStore.getState().startSession({
      user: TEST_USER,
      accessToken: makeSessionPayload().tokens.accessToken,
    });

    expect(getAccessToken()).toBe('memory-only-token');
    expect(window.localStorage.length).toBe(0);
    expect(JSON.stringify(window.localStorage)).not.toContain('memory-only-token');
  });

  it('clears the session after a confirmed sign-out', async () => {
    vi.spyOn(authService, 'logout').mockResolvedValue();
    setAccessToken('memory-only-token');
    useSessionStore.setState({ status: 'authenticated', user: TEST_USER });

    const result = await useSessionStore.getState().signOut();

    expect(result).toEqual({ remoteRevoked: true });
    expect(useSessionStore.getState().status).toBe('anonymous');
    expect(useSessionStore.getState().user).toBeNull();
    expect(getAccessToken()).toBeNull();
  });

  it('still ends the local session when the logout request fails', async () => {
    vi.spyOn(authService, 'logout').mockRejectedValue(
      new HttpApiError('Network unreachable.', { status: 0, code: 'NETWORK_ERROR' }),
    );
    setAccessToken('memory-only-token');
    useSessionStore.setState({ status: 'authenticated', user: TEST_USER });

    const result = await useSessionStore.getState().signOut();

    expect(result).toEqual({ remoteRevoked: false });
    expect(useSessionStore.getState().status).toBe('anonymous');
    expect(useSessionStore.getState().user).toBeNull();
    expect(getAccessToken()).toBeNull();
  });
});
