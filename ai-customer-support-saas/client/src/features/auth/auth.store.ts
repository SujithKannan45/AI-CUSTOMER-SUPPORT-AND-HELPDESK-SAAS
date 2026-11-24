import { create } from 'zustand';
import { HttpApiError } from '@/services/http-client.service';
import { clearAccessToken, setAccessToken, unblockTokenRefresh } from '@/services/auth-token.store';
import { authService } from './auth.service';
import type { PublicUser, SessionStatus } from './types';

export interface SignOutResult {
  /** True only when the server confirmed the refresh token was revoked. */
  remoteRevoked: boolean;
}

export interface SessionState {
  status: SessionStatus;
  user: PublicUser | null;
  error: string | null;
  /** Resolves the session once per app load (silent refresh cookie → /auth/me). */
  bootstrap: () => Promise<void>;
  /** Starts the in-memory session after a successful login. */
  startSession: (payload: { user: PublicUser; accessToken: string }) => void;
  signOut: () => Promise<SignOutResult>;
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
    let remoteRevoked = false;
    try {
      await authService.logout();
      remoteRevoked = true;
    } catch {
      // Local state must still end; the caller decides how honest to be about
      // server-side revocation (see useSignOut).
    }

    clearAccessToken();
    // Entering `anonymous` also clears tenant state through the app-level
    // SessionSyncProvider, so no workspace selection survives the session.
    get().reset();

    return { remoteRevoked };
  },

  reset: () => {
    set({ status: 'anonymous', user: null, error: null });
  },
}));
