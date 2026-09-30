import type { Request, RequestHandler, Response } from 'express';

import { getRequestId } from '../utils/request-id.js';

/**
 * Response contract — the envelope every endpoint returns.
 *
 * Success: `{ success: true, data, requestId? }`
 * Error:   `{ success: false, error: { code, message, details? }, requestId? }`
 *
 * Controllers call `sendSuccess` for the success half; the central error
 * middleware owns the error half. Internal functions do NOT wrap results in
 * envelopes — only the HTTP layer does.
 */

export interface ApiSuccessBody<TData> {
  success: true;
  data: TData;
  requestId?: string;
}

/**
 * Sends a success envelope. Controllers stay one-liners:
 * `sendSuccess(res, 200, result)`.
 */
export function sendSuccess<TData>(
  res: Response,
  statusCode: 200 | 201 | 202 | 204,
  data: TData,
  req?: Request,
): Response {
  const body: ApiSuccessBody<TData> = {
    success: true,
    data,
    ...(req !== undefined ? { requestId: getRequestId(req) } : {}),
  };
  return res.status(statusCode).json(body);
}

/**
 * Wraps an async handler so rejections flow into the central error pipeline —
 * controllers never need try/catch. (Express 5 also forwards rejected
 * promises natively; this makes the guarantee explicit and style-consistent.)
 */
export function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}
