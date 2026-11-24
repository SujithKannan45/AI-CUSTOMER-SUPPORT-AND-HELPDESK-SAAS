import { create } from 'zustand';
import { HttpApiError } from '@/services/http-client.service';
import { clearAccessToken, setAccessToken, unblockTokenRefresh } from '@/services/auth-token.store';
import { authService } from './auth.service';
import type { PublicUser, SessionStatus } from './types';

export interface SessionState {
  status: SessionStatus;
  user: PublicUser | null;
  error: string | null;
  /** Resolves the session once per app load (silent refresh cookie → /auth/me). */
  bootstrap: () => Promise<void>;
  /** Called by the sign-in flow (Prompt 20) after a successful login. */
  startSession: (payload: { user: PublicUser; accessToken: string }) => void;
  signOut: () => Promise<void>;
  /** Drops local session state (auth failure, sign-out, guard reset). */
  reset: () => void;
}

/**
 * Session store — identity only. Workspace/role context is resolved per
 * request by the server (`requireWorkspaceContext`), never trusted here.
 *
 * A page load holds an access token in memory only, so `bootstrap` trades the
 * HttpOnly refresh cookie for a fresh token and then loads the profile. A 401
 * (no/expired cookie) is the normal logged-out path, not an error.
 */
export const useSessionStore = create<SessionState>((set, get) => ({
  status: 'idle',
  user: null,
  error: null,

  bootstrap: async () => {
    const { status } = get();
    if (status === 'loading' || status === 'authenticated') return;

    set({ status: 'loading', error: null });
    unblockTokenRefresh();

    try {
      const user = await authService.getCurrentUser();
      set({ status: 'authenticated', user, error: null });
    } catch (error) {
      if (error instanceof HttpApiError && error.isAuthError) {
        clearAccessToken();
        set({ status: 'anonymous', user: null, error: null });
        return;
      }
      set({
        status: 'error',
        user: null,
        error:
          error instanceof HttpApiError
            ? error.message
            : 'Could not reach the API. Check that the server is running and try again.',
      });
    }
  },

  startSession: ({ user, accessToken }) => {
    setAccessToken(accessToken);
    set({ status: 'authenticated', user, error: null });
  },

  signOut: async () => {
    try {
      await authService.logout();
    } catch {
      // The local session must end even when the network call fails.
    } finally {
      clearAccessToken();
      get().reset();
    }
  },

  reset: () => {
    set({ status: 'anonymous', user: null, error: null });
  },
}));
