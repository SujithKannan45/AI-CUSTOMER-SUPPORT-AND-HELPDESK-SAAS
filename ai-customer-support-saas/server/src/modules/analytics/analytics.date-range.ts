import {
  ANALYTICS_MAX_SPAN_DAYS,
  type AnalyticsBucketUnit,
  type AnalyticsRange,
  type TrendPointDto,
} from './analytics.types.js';

/**
 * Pure date-window + bucket arithmetic (Prompt 18).
 *
 * All analytics timestamps are UTC. The workspace carries a free-form
 * `settings.timezone` string (default `UTC`) that is NOT validated as an IANA
 * zone identifier, so using it for bucketing would be unreliable — analytics
 * deliberately computes in UTC and documents that. No timezone is invented.
 *
 * Boundary convention: `from` INCLUSIVE, `to` EXCLUSIVE, on every endpoint and
 * in every aggregation. Adjacent windows therefore never double-count.
 */

const DAY_MS = 86_400_000;
const PRESET_DAYS: Partial<Record<AnalyticsRange, number>> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

export interface ResolvedAnalyticsWindow {
  readonly range: AnalyticsRange;
  readonly from: Date;
  readonly to: Date;
}

export interface ResolvedAnalyticsPeriod extends ResolvedAnalyticsWindow {
  readonly bucket: AnalyticsBucketUnit;
}

/** UTC start of the calendar day containing `date`. */
export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Truncates to the start of the UTC bucket, matching MongoDB `$dateTrunc`
 * semantics used by the repository: day = 00:00 UTC, week = Monday 00:00 UTC
 * (`startOfWeek: 'monday'`), month = first day 00:00 UTC.
 */
export function startOfBucket(date: Date, unit: AnalyticsBucketUnit): Date {
  if (unit === 'month') {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  }
  if (unit === 'week') {
    const dayStart = startOfUtcDay(date);
    const mondayOffset = (dayStart.getUTCDay() + 6) % 7;
    return new Date(dayStart.getTime() - mondayOffset * DAY_MS);
  }
  return startOfUtcDay(date);
}

function addBucket(date: Date, unit: AnalyticsBucketUnit): Date {
  if (unit === 'month') {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  }
  if (unit === 'week') return new Date(date.getTime() + 7 * DAY_MS);
  return new Date(date.getTime() + DAY_MS);
}

/**
 * Resolves a validated query into concrete UTC bounds.
 *
 * Presets are relative to the server's current instant; `today` is the current
 * UTC calendar day. `custom` uses the supplied bounds verbatim (already
 * validated as well-formed, ordered and ≤ the maximum span).
 */
export function resolveAnalyticsWindow(
  query: {
    readonly range?: AnalyticsRange;
    readonly from?: string;
    readonly to?: string;
  },
  now: Date = new Date(),
): ResolvedAnalyticsWindow {
  if (query.range === 'custom' || (query.from !== undefined && query.to !== undefined)) {
    // Both bounds are guaranteed present by the query schema for these shapes.
    return {
      range: 'custom',
      from: new Date(query.from as string),
      to: new Date(query.to as string),
    };
  }

  const range: AnalyticsRange = query.range ?? '30d';
  if (range === 'today') {
    return { range, from: startOfUtcDay(now), to: now };
  }
  const days = PRESET_DAYS[range] ?? 30;
  return { range, from: new Date(now.getTime() - days * DAY_MS), to: now };
}

/** Maximum accepted window span (also enforced by validation). */
export function exceedsMaxSpan(from: Date, to: Date): boolean {
  return to.getTime() - from.getTime() > ANALYTICS_MAX_SPAN_DAYS * DAY_MS;
}

/**
 * Ordered UTC bucket starts covering `[from, to)`. Bounded by the 366-day
 * maximum window, so the largest day series is 366 points (~13 month points).
 */
export function bucketStarts(
  from: Date,
  to: Date,
  unit: AnalyticsBucketUnit,
): readonly Date[] {
  const starts: Date[] = [];
  let cursor = startOfBucket(from, unit);
  const limit = ANALYTICS_MAX_SPAN_DAYS + 2;
  while (cursor.getTime() < to.getTime() && starts.length < limit) {
    starts.push(cursor);
    cursor = addBucket(cursor, unit);
  }
  return starts;
}

/**
 * Builds a zero-filled, deterministic trend series. `counts` is keyed by the
 * ISO string of each bucket start produced by the aggregation; buckets with no
 * rows are genuine zeros, not gaps.
 */
export function fillTrend(
  starts: readonly Date[],
  counts: ReadonlyMap<string, number>,
): readonly TrendPointDto[] {
  return starts.map((start) => {
    const bucket = start.toISOString();
    return { bucket, count: counts.get(bucket) ?? 0 };
  });
}

/** ISO key for an aggregation bucket value (Date or ISO string). */
export function bucketKey(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** Rounds to whole milliseconds; returns null for non-finite input. */
export function roundMs(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value);
}
