import { apiRequest, ensureFreshAccessToken } from '@/services/http-client.service';
import type { AuthSessionPayload, PublicUser } from './types';

/**
 * Auth endpoints (backend contracts in `server/src/modules/auth`).
 *
 * Token handling notes:
 * - The login/refresh responses carry the access token in JSON; the refresh
 *   token is ALSO set as an HttpOnly cookie scoped to `/api/v1/auth`, which is
 *   the only copy JavaScript can never read.
 * - `logout` deliberately skips the transparent refresh-and-retry: a 401 there
 *   means the session is already gone.
 */
export const authService = {
  /** GET /api/v1/auth/me — current user (the session probe). */
  async getCurrentUser(): Promise<PublicUser> {
    const payload = await apiRequest<{ user: PublicUser }>('/api/v1/auth/me');
    return payload.user;
  },

  /** POST /api/v1/auth/login — credentials → user + access token (refresh cookie set). */
  login(input: { email: string; password: string }): Promise<AuthSessionPayload> {
    return apiRequest<AuthSessionPayload>('/api/v1/auth/login', {
      method: 'POST',
      body: input,
      skipAuthRefresh: true,
    });
  },

  /** POST /api/v1/auth/refresh — rotates the refresh cookie, returns an access token. */
  requestSessionRefresh(): Promise<boolean> {
    return ensureFreshAccessToken();
  },

  /** POST /api/v1/auth/logout — revokes the refresh token and clears the cookie. */
  async logout(): Promise<void> {
    await apiRequest<{ loggedOut: boolean }>('/api/v1/auth/logout', {
      method: 'POST',
      skipAuthRefresh: true,
    });
  },

  /**
   * POST /api/v1/auth/forgot-password — asks the server to email a one-time
   * reset link. Responds identically for every address (no enumeration).
   */
  async requestPasswordReset(email: string): Promise<{ queued: boolean }> {
    return apiRequest<{ queued: boolean }>('/api/v1/auth/forgot-password', {
      method: 'POST',
      body: { email },
      skipAuthRefresh: true,
    });
  },

  /**
   * POST /api/v1/auth/reset-password — consumes the emailed token and sets the
   * new password. The server revokes all live sessions on success.
   */
  async resetPassword(input: { email: string; token: string; password: string }): Promise<{ passwordReset: boolean }> {
    return apiRequest<{ passwordReset: boolean }>('/api/v1/auth/reset-password', {
      method: 'POST',
      body: input,
      skipAuthRefresh: true,
    });
  },
};
