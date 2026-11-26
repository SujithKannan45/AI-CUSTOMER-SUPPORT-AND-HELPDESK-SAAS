/**
 * Date formatting for record surfaces (customers, tickets).
 *
 * The API returns ISO-8601 instants; every formatter renders them in UTC so a
 * record shows the same day on every machine and matches the dashboard, which
 * already states that its windows are UTC. A missing value renders as an em
 * dash — never a fabricated date.
 */

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

function parse(iso: string | null): Date | null {
  if (iso === null || iso.length === 0) return null;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** `Nov 25, 2026, 9:41 AM` (UTC), or `—`. */
export function formatDateTime(iso: string | null): string {
  const date = parse(iso);
  return date === null ? '—' : DATE_TIME_FORMAT.format(date);
}

/** `Nov 25, 2026` (UTC), or `—`. */
export function formatDate(iso: string | null): string {
  const date = parse(iso);
  return date === null ? '—' : DATE_FORMAT.format(date);
}
