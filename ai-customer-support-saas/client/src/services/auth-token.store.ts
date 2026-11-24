/**
 * In-memory access-token holder.
 *
 * The access token is NEVER persisted (no localStorage/sessionStorage): XSS
 * cannot read it from disk, and a reload silently re-establishes the session
 * from the HttpOnly refresh cookie. The refresh token is not readable by
 * JavaScript at all — the server keeps it in a `refresh_token` cookie scoped
 * to `/api/v1/auth`.
 *
 * Kept as a framework-free module (no React, no fetch) so the HTTP client,
 * the session store and tests can share it without import cycles.
 */

let accessToken: string | null = null;

/**
 * After a refresh failure the client must stop asking: rotating-token reuse
 * detection on the server revokes the whole session family, and the refresh
 * route is rate limited. The flag is cleared by a successful token set or by
 * an explicit new bootstrap (`unblockTokenRefresh`).
 */
let refreshBlocked = false;

const authFailureListeners = new Set<() => void>();

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
  if (token !== null) refreshBlocked = false;
}

export function clearAccessToken(): void {
  accessToken = null;
  refreshBlocked = true;
}

export function isTokenRefreshBlocked(): boolean {
  return refreshBlocked;
}

export function blockTokenRefresh(): void {
  refreshBlocked = true;
}

export function unblockTokenRefresh(): void {
  refreshBlocked = false;
}

/** Subscribes to "the session is gone" events (refresh rejected). */
export function subscribeToAuthFailure(listener: () => void): () => void {
  authFailureListeners.add(listener);
  return () => {
    authFailureListeners.delete(listener);
  };
}

/** Notifies listeners that the session ended; never throws on a bad listener. */
export function notifyAuthFailure(): void {
  for (const listener of authFailureListeners) {
    try {
      listener();
    } catch (error) {
      console.error('Auth-failure listener threw', error);
    }
  }
}
