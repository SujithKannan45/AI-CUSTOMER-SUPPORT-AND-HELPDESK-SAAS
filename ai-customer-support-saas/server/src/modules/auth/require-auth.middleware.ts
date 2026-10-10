import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../../core/errors/app-error.js';
import { UserModel } from '../users/user.model.js';

import { verifyAccessToken } from './auth.tokens.js';

/**
 * Authentication middleware — resolves the caller's identity or rejects the
 * request. Deliberately does NOT authorize: role/workspace checks belong to
 * later middleware that composes on top of `req.auth`.
 *
 * Pipeline:
 *   1. Extract the bearer token from `Authorization: Bearer <jwt>`.
 *   2. Verify signature/expiration/type — failures are a uniform 401 that
 *      never reveals WHY (invalid vs expired) to avoid giving attackers a
 *      token oracle.
 *   3. Load the user and enforce live account state: the account must still
 *      exist, be `active`, and carry the current `tokenVersion` (the global
 *      kill switch — bumping it instantly invalidates every issued token).
 *   4. Attach the typed `AuthUser` context to `req.auth`.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ')) {
    next(AppError.unauthorized());
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  if (token.length === 0) {
    next(AppError.unauthorized());
    return;
  }

  let payload;
  try {
    payload = await verifyAccessToken(token);
  } catch {
    next(AppError.unauthorized());
    return;
  }

  const user = await UserModel.findById(payload.sub).select('+tokenVersion');
  if (
    user === null ||
    user.status !== 'active' ||
    user.tokenVersion !== 0 // tokenVersion > 0 ⇒ global revocation (future: per-user version tracking in the JWT)
  ) {
    next(AppError.unauthorized());
    return;
  }

  req.auth = { userId: payload.sub };
  next();
}
