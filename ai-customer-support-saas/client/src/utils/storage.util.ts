/**
 * Safe `localStorage` helpers.
 *
 * Storage can throw (private mode, disabled cookies, quota) — UI preferences
 * must never crash the app over a failed write, so failures degrade to
 * in-memory behaviour for the session.
 */

/** Keys owned by the client app (never secrets — only UI preferences). */
export const STORAGE_KEYS = {
  theme: 'ui-theme',
  activeWorkspace: 'active-workspace-id',
} as const;

export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Preference persistence is best-effort by design.
  }
}
