import { z } from 'zod';

import {
  ANALYTICS_BUCKETS,
  ANALYTICS_MAX_SPAN_DAYS,
  ANALYTICS_RANGES,
  type AnalyticsBucketUnit,
  type AnalyticsRange,
} from './analytics.types.js';

/**
 * Analytics query validation (Prompt 18).
 *
 * `.strict()` rejects unknown keys, so no client value can add a Mongo field,
 * stage or operator. Date bounds are ISO-8601 datetimes with an explicit
 * offset (the project convention), ordered, and capped at a 366-day span.
 *
 * Window rules:
 * - `range=custom` REQUIRES both `from` and `to`.
 * - Supplying `from`/`to` without `range` is treated as a custom window.
 * - Supplying `from`/`to` together with a preset range is contradictory → 422.
 * - Exactly one of `from`/`to` is always invalid.
 */

const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-f\d]{24}$/i, 'Must be a 24-character hex string');

export const analyticsParamsSchema = z
  .object({ workspaceId: objectIdSchema })
  .strict();

export interface AnalyticsParams {
  readonly workspaceId: string;
}

const isoDateSchema = z.string().trim().datetime({ offset: true });

const rangeFields = {
  range: z.enum(ANALYTICS_RANGES).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
};

const MAX_SPAN_MS = ANALYTICS_MAX_SPAN_DAYS * 86_400_000;

/** Shared structural + numeric checks for the three range shapes. */
function validateRangeWindow(
  query: {
    range?: AnalyticsRange;
    from?: string;
    to?: string;
  },
  context: z.RefinementCtx,
): void {
  const hasBounds = query.from !== undefined || query.to !== undefined;

  if (query.range === 'custom' && (query.from === undefined || query.to === undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'range=custom requires both from and to',
      path: ['from'],
    });
    return;
  }

  if (hasBounds && query.range !== undefined && query.range !== 'custom') {
    context.addIssue({
      code: 'custom',
      message: 'from/to cannot be combined with a preset range; use range=custom',
      path: ['range'],
    });
    return;
  }

  if ((query.from === undefined) !== (query.to === undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'Provide both from and to (or neither)',
      path: ['from'],
    });
    return;
  }

  if (query.from !== undefined && query.to !== undefined) {
    const from = new Date(query.from).getTime();
    const to = new Date(query.to).getTime();
    if (from >= to) {
      context.addIssue({
        code: 'custom',
        message: 'from must be strictly before to',
        path: ['from'],
      });
      return;
    }
    if (to - from > MAX_SPAN_MS) {
      context.addIssue({
        code: 'custom',
        message: `Date range must not exceed ${ANALYTICS_MAX_SPAN_DAYS} days`,
        path: ['from'],
      });
    }
  }
}

export const analyticsRangeQuerySchema = z
  .object(rangeFields)
  .strict()
  .superRefine(validateRangeWindow);

export interface AnalyticsRangeQuery {
  readonly range?: AnalyticsRange;
  readonly from?: string;
  readonly to?: string;
}

export const analyticsTimeSeriesQuerySchema = z
  .object({
    ...rangeFields,
    bucket: z.enum(ANALYTICS_BUCKETS).default('day'),
  })
  .strict()
  .superRefine(validateRangeWindow);

export interface AnalyticsTimeSeriesQuery extends AnalyticsRangeQuery {
  readonly bucket: AnalyticsBucketUnit;
}

/** Hard bound for the ticket CSV export (bounded execution + response size). */
export const MAX_REPORT_ROWS = 5_000;

export const ticketReportQuerySchema = z
  .object(rangeFields)
  .strict()
  .superRefine(validateRangeWindow);

export interface TicketReportQuery extends AnalyticsRangeQuery {
  readonly unused?: never;
}
