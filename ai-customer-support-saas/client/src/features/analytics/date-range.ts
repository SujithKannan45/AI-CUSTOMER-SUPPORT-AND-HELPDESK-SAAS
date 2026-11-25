import type { AnalyticsBucketUnit, AnalyticsPeriodDto, AnalyticsRangeFilter } from './types';

/**
 * Dashboard date-range model.
 *
 * Presets and custom windows are exactly the backend contract
 * (`range=7d|30d|90d|custom`, `from` inclusive, `to` exclusive, UTC, ≤ 366
 * days). The date inputs are calendar days; they are converted to UTC
 * boundaries here so the UI never invents a timezone or sends a local offset.
 */

export const DASHBOARD_PRESETS = [
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: '90d', label: 'Last 90 days' },
] as const;

export type DashboardPreset = (typeof DASHBOARD_PRESETS)[number]['id'];

export type DashboardSelection =
  | { readonly kind: 'preset'; readonly preset: DashboardPreset }
  | { readonly kind: 'custom'; readonly from: string; readonly to: string };

export const DEFAULT_SELECTION: DashboardSelection = { kind: 'preset', preset: '30d' };

const DAY_MS = 86_400_000;
export const MAX_CUSTOM_RANGE_DAYS = 366;
const DATE_INPUT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** UTC calendar day `days` before `now`, as `yyyy-mm-dd`. */
export function daysAgoUtc(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10);
}

/** Current UTC calendar day, as `yyyy-mm-dd`. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** True for a well-formed `yyyy-mm-dd` calendar date (no roll-over accepted). */
export function isValidDateInput(value: string): boolean {
  if (!DATE_INPUT_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Returns a field-level message, or null when the custom range is valid. */
export function validateCustomRange(from: string, to: string): string | null {
  if (from.length === 0 || to.length === 0) return 'Choose both a start and an end date.';
  if (!isValidDateInput(from) || !isValidDateInput(to)) return 'Enter valid calendar dates.';
  if (from > to) return 'The start date must be on or before the end date.';

  const spanDays =
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS + 1;
  if (spanDays > MAX_CUSTOM_RANGE_DAYS) {
    return `Choose a range of ${MAX_CUSTOM_RANGE_DAYS} days or fewer.`;
  }
  return null;
}

/** Calendar days → UTC half-open bounds (`to` becomes the next UTC midnight). */
export function customBounds(from: string, to: string): { from: string; to: string } {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(Date.parse(`${to}T00:00:00.000Z`) + DAY_MS);
  return { from: start.toISOString(), to: end.toISOString() };
}

export function selectionToFilter(selection: DashboardSelection): AnalyticsRangeFilter {
  if (selection.kind === 'preset') return { range: selection.preset };
  return { range: 'custom', ...customBounds(selection.from, selection.to) };
}

/**
 * Presentation-only bucket choice for the trend endpoint: short windows stay
 * daily, longer custom windows coarsen so axis labels remain readable. The
 * response's own `period.bucket` is what the chart formats against.
 */
export function bucketForFilter(filter: AnalyticsRangeFilter): AnalyticsBucketUnit {
  if (filter.range !== 'custom') return 'day';

  const spanDays = (Date.parse(filter.to) - Date.parse(filter.from)) / DAY_MS;
  if (spanDays > 180) return 'month';
  if (spanDays > 45) return 'week';
  return 'day';
}

export function selectionLabel(selection: DashboardSelection): string {
  if (selection.kind === 'preset') {
    return DASHBOARD_PRESETS.find((item) => item.id === selection.preset)?.label ?? 'Last 30 days';
  }
  return 'Custom range';
}

const PERIOD_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Human label for the server-resolved window (`to` is exclusive → last ms). */
export function formatPeriodLabel(period: Pick<AnalyticsPeriodDto, 'from' | 'to'>): string {
  const start = PERIOD_FORMAT.format(new Date(period.from));
  const end = PERIOD_FORMAT.format(new Date(Date.parse(period.to) - 1));
  return start === end ? start : `${start} – ${end}`;
}

const BUCKET_DAY_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

const BUCKET_MONTH_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  year: '2-digit',
  timeZone: 'UTC',
});

/** Axis/tooltip label for a zero-filled bucket start. */
export function formatBucketLabel(bucket: string, unit: AnalyticsBucketUnit): string {
  const date = new Date(bucket);
  if (!Number.isFinite(date.getTime())) return '—';
  return unit === 'month' ? BUCKET_MONTH_FORMAT.format(date) : BUCKET_DAY_FORMAT.format(date);
}
