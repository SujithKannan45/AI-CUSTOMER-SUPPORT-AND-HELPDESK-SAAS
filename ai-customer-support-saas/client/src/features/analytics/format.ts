/** Number/duration formatting used by the dashboard. Pure and locale-stable. */

const COUNT_FORMAT = new Intl.NumberFormat('en-US');

export function formatCount(value: number): string {
  return COUNT_FORMAT.format(Number.isFinite(value) ? value : 0);
}

/**
 * Formats a backend millisecond duration. Returns an em dash for `null`
 * (the server's "no measurable population" value) — never 0, which would
 * claim a real zero-duration measurement.
 */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';

  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 1) return '< 1 min';

  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}
