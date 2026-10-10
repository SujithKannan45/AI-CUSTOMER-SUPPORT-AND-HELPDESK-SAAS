import type { Request, RequestHandler, Response } from 'express';

import { env } from '../../config/env.config.js';
import { AppError } from '../../core/errors/app-error.js';
import { asyncHandler, sendSuccess } from '../../core/http/api-response.js';

import {
  forgotPassword,
  getMe,
  login,
  logout,
  logoutAll,
  refresh,
  register,
  resendVerificationEmail,
  resetPassword,
  verifyEmail,
} from './auth.service.js';
import { REFRESH_COOKIE_NAME } from './auth.tokens.js';
import type { LoginInput, RegisterInput } from './auth.validation.js';

/**
 * Auth controllers — HTTP shape only: parse request → call service → respond.
 * Every success uses the standard `sendSuccess` envelope; errors flow to the
 * central error middleware via `asyncHandler`.
 */

/** Environment-aware refresh-cookie options (see prompt §11). */
function refreshCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'strict' | 'lax' | 'none';
  path: string;
  maxAge: number;
  domain?: string;
} {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE === 'auto' ? env.NODE_ENV === 'production' : env.COOKIE_SECURE === 'true',
    sameSite: env.COOKIE_SAMESITE,
    path: '/api/v1/auth', // Scoped so the browser sends it ONLY to auth endpoints.
    maxAge: 7 * 24 * 3600 * 1000, // Kept in sync with JWT_REFRESH_TTL default (7d).
    ...(env.COOKIE_DOMAIN !== undefined ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

function setRefreshCookie(res: Response, rawToken: string): void {
  res.cookie(REFRESH_COOKIE_NAME, rawToken, refreshCookieOptions());
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
}

/** Reads the refresh token from the HttpOnly cookie (preferred) or JSON body fallback. */
function readRefreshToken(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  const fromCookie = cookies?.[REFRESH_COOKIE_NAME];
  if (typeof fromCookie === 'string' && fromCookie.length > 0) return fromCookie;
  const body = req.body as Record<string, unknown> | undefined;
  const fromBody = body?.['refreshToken'];
  return typeof fromBody === 'string' && fromBody.length > 0 ? fromBody : undefined;
}

export const registerController: RequestHandler = asyncHandler(async (req, res) => {
  const input = req.body as RegisterInput;
  const result = await register(input, req);
  sendSuccess(res, 201, result, req);
});

export const verifyEmailController: RequestHandler = asyncHandler(async (req, res) => {
  const user = await verifyEmail(req.body as { email: string; token: string }, req);
  sendSuccess(res, 200, { user }, req);
});

export const resendVerificationController: RequestHandler = asyncHandler(async (req, res) => {
  const result = await resendVerificationEmail(req.body as { email: string }, req);
  sendSuccess(res, 200, result, req);
});

export const loginController: RequestHandler = asyncHandler(async (req, res) => {
  const input = req.body as LoginInput;
  const { user, tokens, refreshToken } = await login(input, req);
  setRefreshCookie(res, refreshToken);
  sendSuccess(res, 200, { user, tokens }, req);
});

export const refreshController: RequestHandler = asyncHandler(async (req, res) => {
  const rawToken = readRefreshToken(req);
  if (rawToken === undefined) {
    throw AppError.unauthorized('Refresh token missing');
  }
  const result = await refresh(rawToken, req);
  setRefreshCookie(res, result.refreshToken);
  sendSuccess(
    res,
    200,
    { accessToken: result.accessToken, expiresIn: result.expiresIn, refreshInCookie: true },
    req,
  );
});

export const logoutController: RequestHandler = asyncHandler(async (req, res) => {
  await logout(readRefreshToken(req), req);
  clearRefreshCookie(res);
  sendSuccess(res, 200, { loggedOut: true }, req);
});

export const logoutAllController: RequestHandler = asyncHandler(async (req, res) => {
  const result = await logoutAll(req.auth!, req);
  clearRefreshCookie(res);
  sendSuccess(res, 200, result, req);
});

export const meController: RequestHandler = asyncHandler(async (req, res) => {
  const user = await getMe(req.auth!.userId);
  sendSuccess(res, 200, { user }, req);
});

export const forgotPasswordController: RequestHandler = asyncHandler(async (req, res) => {
  const result = await forgotPassword(req.body as { email: string }, req);
  sendSuccess(res, 200, result, req);
});

export const resetPasswordController: RequestHandler = asyncHandler(async (req, res) => {
  await resetPassword(req.body as { email: string; token: string; password: string }, req);
  sendSuccess(res, 200, { passwordReset: true }, req);
});
