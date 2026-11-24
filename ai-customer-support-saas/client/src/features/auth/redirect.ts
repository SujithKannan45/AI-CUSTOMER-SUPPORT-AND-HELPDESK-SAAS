import { ROUTES } from '@/app/routes/route-paths';

/**
 * Router state helpers for the auth screens.
 *
 * `from` is written by `RequireAuth` and read here. Only in-app absolute paths
 * are accepted, so a crafted history state can never send a freshly
 * authenticated user to another origin (open-redirect protection).
 */

interface LocationStateLike {
  from?: unknown;
  notice?: unknown;
}

function asStateObject(state: unknown): LocationStateLike | null {
  return typeof state === 'object' && state !== null ? state : null;
}

/** A safe internal return path, or undefined when absent/unsafe. */
export function readFromPath(state: unknown): string | undefined {
  const from = asStateObject(state)?.from;
  if (typeof from !== 'string') return undefined;
  if (!from.startsWith('/') || from.startsWith('//')) return undefined;
  if (from === ROUTES.login || from.startsWith(`${ROUTES.login}?`)) return undefined;
  return from;
}

/** One-time success/info message carried through navigation state. */
export function readNotice(state: unknown): string | undefined {
  const notice = asStateObject(state)?.notice;
  return typeof notice === 'string' && notice.length > 0 ? notice : undefined;
}

/**
 * Where to send a just-authenticated user: the guarded route they originally
 * asked for, otherwise the dashboard. The workspace gate takes over from there
 * and routes accounts without a membership to the picker.
 */
export function postLoginDestination(state: unknown): string {
  return readFromPath(state) ?? ROUTES.dashboard;
}
