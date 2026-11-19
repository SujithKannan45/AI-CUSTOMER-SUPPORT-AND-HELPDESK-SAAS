import type { Request, RequestHandler } from 'express';

import { asyncHandler, sendSuccess } from '../../core/http/api-response.js';

import {
  getAiAnalyticsFlow,
  getOverviewFlow,
  getPerformanceFlow,
  getTicketAnalyticsFlow,
  getTicketReportFlow,
  type AnalyticsRequestContext,
} from './analytics.service.js';
import type { AnalyticsTimeSeriesQuery } from './analytics.validation.js';

/**
 * Analytics controllers — HTTP shape only (validated input → service →
 * envelope). Authentication, workspace context and the `analytics.view`
 * permission already ran in middleware, so no handler re-derives identity or
 * reads a client-supplied workspace id.
 */

function contextOf(req: Request): AnalyticsRequestContext {
  return { workspaceId: req.workspace!.workspaceId };
}

/** GET …/analytics/overview — workspace KPI snapshot for the window. */
export const getOverviewController: RequestHandler = asyncHandler(async (req, res) => {
  const payload = await getOverviewFlow(
    contextOf(req),
    req.query,
  );
  sendSuccess(res, 200, payload, req);
});

/** GET …/analytics/tickets — trends, breakdowns and resolution durations. */
export const getTicketAnalyticsController: RequestHandler = asyncHandler(async (req, res) => {
  const payload = await getTicketAnalyticsFlow(
    contextOf(req),
    req.query as unknown as AnalyticsTimeSeriesQuery,
  );
  sendSuccess(res, 200, payload, req);
});

/** GET …/analytics/performance — backlog, durations, reply and volume metrics. */
export const getPerformanceController: RequestHandler = asyncHandler(async (req, res) => {
  const payload = await getPerformanceFlow(
    contextOf(req),
    req.query,
  );
  sendSuccess(res, 200, payload, req);
});

/** GET …/analytics/ai — audit-trail-derived AI usage (content-free). */
export const getAiAnalyticsController: RequestHandler = asyncHandler(async (req, res) => {
  const payload = await getAiAnalyticsFlow(
    contextOf(req),
    req.query as unknown as AnalyticsTimeSeriesQuery,
  );
  sendSuccess(res, 200, payload, req);
});

/**
 * GET …/analytics/reports/tickets.csv — bounded, machine-field-only CSV.
 * Private data: `Cache-Control: no-store`; the filename is sanitized and the
 * payload is built entirely in memory from a capped (5,000-row) query.
 */
export const exportTicketsController: RequestHandler = asyncHandler(async (req, res) => {
  const result = await getTicketReportFlow(
    contextOf(req),
    req.query,
  );
  res
    .status(200)
    .setHeader('Content-Type', 'text/csv; charset=utf-8')
    .setHeader('Content-Disposition', `attachment; filename="${result.filename}"`)
    .setHeader('Cache-Control', 'no-store')
    .setHeader('X-Content-Type-Options', 'nosniff')
    .send(result.csv);
});
