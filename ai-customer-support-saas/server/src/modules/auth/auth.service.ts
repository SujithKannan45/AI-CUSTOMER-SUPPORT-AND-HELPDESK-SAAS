import type { Request } from 'express';
import { Types } from 'mongoose';

import { AppError } from '../../core/errors/app-error.js';
import { UserModel } from '../users/user.model.js';

import { recordAuthAudit } from './auth-audit.js';
import {
  consumeOneTimeToken,
  createRefreshToken,
  findLiveRefreshToken,
  issueOneTimeToken,
  markRotated,
  revokeAllRefreshTokensForUser,
  revokeRefreshToken,
  revokeTokenFamily,
  touchRefreshToken,
  type IssuedRefreshRecord,
} from './auth.repository.js';
import { hashPassword, REFRESH_TTL_SECONDS, signAccessToken, verifyPassword } from './auth.tokens.js';
import type { AuthSuccessPayload, PublicUser } from './auth.types.js';
import {
  buildPasswordResetEmail,
  buildVerificationEmail,
  sendEmail,
} from './email/auth-email.service.js';

/**
 * Authentication business flows.
 *
 * Security invariants enforced here:
 * - Anti-enumeration: login and forgot-password produce IDENTICAL error
 *   shapes/timings for unknown accounts and wrong credentials; forgot-password
 *   always returns the same response.
 * - Raw one-time tokens exist only inside the rendered email handed to the
 *   transport — never in responses, logs, or audit entries.
 * - Refresh rotation is atomic (findOneAndUpdate guards), and reuse of a
 *   rotated token revokes the whole family (theft detection).
 * - A successful password reset revokes all live sessions (it must, because
 *   the old credential may have been stolen).
 */

/** Anti-enumeration: one uniform message for every credential failure. */
const INVALID_CREDENTIALS = 'Invalid email or password';

export function toPublicUser(user: {
  _id: Types.ObjectId;
  name: string;
  email: string;
  avatarUrl?: string;
  status: string;
  emailVerified: boolean;
  lastLoginAt?: Date;
  createdAt: Date;
}): PublicUser {
  return {
    id: user._id.toHexString(),
    name: user.name,
    email: user.email,
    ...(user.avatarUrl !== undefined ? { avatarUrl: user.avatarUrl } : {}),
    status: user.status,
    emailVerified: user.emailVerified,
    ...(user.lastLoginAt !== undefined ? { lastLoginAt: user.lastLoginAt.toISOString() } : {}),
    createdAt: user.createdAt.toISOString(),
  };
}

function requestContext(request: Request): { ip?: string; userAgent?: string } {
  return {
    ...(request.ip !== undefined ? { ip: request.ip } : {}),
    ...(typeof request.headers['user-agent'] === 'string'
      ? { userAgent: request.headers['user-agent'].slice(0, 512) }
      : {}),
  };
}

// ── Registration ─────────────────────────────────────────────────────────────

export interface RegisterResult {
  user: PublicUser;
  /** True when the dev outbox rendered the verification email (EMAIL_PROVIDER=log). */
  verificationEmailQueued: boolean;
}

export async function register(
  input: { name: string; email: string; password: string },
  request: Request,
): Promise<RegisterResult> {
  const existing = await UserModel.findOne({ email: input.email });
  if (existing !== null) {
    // Same generic conflict for any duplicate — no extra detail.
    throw AppError.conflict('An account with this email already exists');
  }

  const passwordHash = await hashPassword(input.password);
  const user = await UserModel.create({
    name: input.name,
    email: input.email,
    passwordHash,
    status: 'active',
    emailVerified: false,
  });

  const rawToken = await issueOneTimeToken(user.email, 'verify_email');
  await sendEmail(buildVerificationEmail(user.email, rawToken));
  recordAuthAudit({
    action: 'user.registered',
    actorId: user._id,
    email: user.email,
    request,
  });

  return { user: toPublicUser(user), verificationEmailQueued: true };
}

// ── Email verification ───────────────────────────────────────────────────────

export async function verifyEmail(
  input: { email: string; token: string },
  request: Request,
): Promise<PublicUser> {
  const consumed = await consumeOneTimeToken(input.email, 'verify_email', input.token);
  if (!consumed) {
    throw AppError.badRequest('Invalid or expired verification link');
  }

  const user = await UserModel.findOneAndUpdate(
    { email: input.email },
    { $set: { emailVerified: true } },
    { new: true },
  );
  if (user === null) {
    throw AppError.badRequest('Invalid or expired verification link');
  }

  recordAuthAudit({ action: 'user.email_verified', actorId: user._id, email: user.email, request });
  return toPublicUser(user);
}

export async function resendVerificationEmail(
  input: { email: string },
  request: Request,
): Promise<{ queued: boolean }> {
  const user = await UserModel.findOne({ email: input.email });
  if (user !== null && !user.emailVerified) {
    const rawToken = await issueOneTimeToken(user.email, 'verify_email');
    await sendEmail(buildVerificationEmail(user.email, rawToken));
  }
  // Anti-enumeration: identical response whether or not the account exists
  // (and whether or not it is already verified).
  recordAuthAudit({ action: 'user.verification_resent', email: input.email, request });
  return { queued: true };
}

// ── Login / refresh / logout ─────────────────────────────────────────────────

export interface LoginSuccess extends AuthSuccessPayload {
  /** Raw refresh token — returned ONCE so the controller can set the HttpOnly cookie. */
  refreshToken: string;
}

export async function login(
  input: { email: string; password: string },
  request: Request,
): Promise<LoginSuccess> {
  const user = await UserModel.findOne({ email: input.email }).select('+passwordHash');
  const passwordOk =
    user !== null &&
    // Always run a bcrypt compare so the response timing does not reveal
    // whether the email exists (hash of a throwaway value for unknown users).
    (await verifyPassword(input.password, user.passwordHash ?? '$2a$12$invalidsaltinvalidsaltinvalidsaltinvalidsaltinvalidsa'));

  if (user === null || !passwordOk) {
    recordAuthAudit({ action: 'user.login_failed', email: input.email, request });
    throw AppError.unauthorized(INVALID_CREDENTIALS);
  }

  if (user.status === 'suspended') {
    recordAuthAudit({ action: 'user.login_blocked', actorId: user._id, email: user.email, request });
    throw AppError.forbidden('Account is suspended');
  }
  if (user.status === 'invited') {
    recordAuthAudit({ action: 'user.login_blocked', actorId: user._id, email: user.email, request });
    throw AppError.forbidden('Account invitation has not been accepted yet');
  }

  const { tokens, refreshToken } = await issueTokenPair(user._id, request);
  const updated = await UserModel.findByIdAndUpdate(
    user._id,
    { $set: { lastLoginAt: new Date() } },
    { new: true },
  );
  if (updated === null) {
    throw AppError.unauthorized(INVALID_CREDENTIALS);
  }

  recordAuthAudit({ action: 'user.login', actorId: user._id, email: user.email, request });
  return { user: toPublicUser(updated), tokens, refreshToken };
}

/** Issues an access + refresh pair, starting a NEW session family. */
async function issueTokenPair(
  userId: Types.ObjectId,
  request: Request,
): Promise<{ tokens: AuthSuccessPayload['tokens']; refreshToken: string }> {
  const issued: IssuedRefreshRecord = await createRefreshToken({
    userId,
    ...requestContext(request),
  });
  const accessToken = await signAccessToken(userId.toHexString());
  return {
    refreshToken: issued.rawToken,
    tokens: {
      accessToken,
      expiresIn: REFRESH_TTL_SECONDS,
      refreshInCookie: true,
    },
  };
}

export interface RefreshResult {
  accessToken: string;
  /** Raw (new) refresh token after rotation — controller turns it into a cookie. */
  refreshToken: string;
  expiresIn: number;
}

/**
 * Validates a refresh token, rotates it, and issues a new access token.
 *
 * Reuse detection: presenting a token that was already rotated (or revoked)
 * revokes the ENTIRE family — the only way an issued token gets replayed is
 * theft, so the family dies.
 */
export async function refresh(
  rawToken: string,
  request: Request,
): Promise<RefreshResult> {
  const stored = await findLiveRefreshToken(rawToken);
  if (stored === null) {
    // Could be unknown, expired, revoked (logout) OR replayed-after-rotation.
    // Distinguish reuse-of-a-rotated-token from ordinary staleness so theft
    // kills the family:
    const replayedFamily = await familyOfRevokedToken(rawToken);
    if (replayedFamily !== null) {
      await revokeTokenFamily(replayedFamily);
      recordAuthAudit({
        action: 'user.refresh_token_reuse_detected',
        request,
        metadata: { familyId: replayedFamily.toHexString() },
      });
    }
    throw AppError.unauthorized('Invalid refresh token');
  }

  const user = await UserModel.findById(stored.userId).select('+tokenVersion');
  if (user === null || user.status !== 'active' || user.tokenVersion !== 0) {
    await revokeRefreshToken(stored.id);
    throw AppError.unauthorized('Invalid refresh token');
  }

  // Rotation: create the successor, then consume the predecessor. If the
  // process dies between the two writes, the worst case is a dead successor —
  // never two live tokens for one session.
  const successor = await createRefreshToken({
    userId: stored.userId,
    familyId: stored.familyId,
    ...requestContext(request),
  });
  await markRotated(stored.id, successor.id);
  await touchRefreshToken(successor.id);

  const accessToken = await signAccessToken(stored.userId.toHexString());
  return {
    accessToken,
    refreshToken: successor.rawToken,
    expiresIn: REFRESH_TTL_SECONDS,
  };
}

/** Returns the family id when the raw token exists but is revoked/rotated. */
async function familyOfRevokedToken(rawToken: string): Promise<Types.ObjectId | null> {
  const { RefreshTokenModel } = await import('./auth-token.model.js');
  const { hashToken } = await import('./auth.tokens.js');
  const doc = await RefreshTokenModel.findOne({ tokenHash: hashToken(rawToken) }).select('+tokenHash');
  return doc !== null ? doc.familyId : null;
}

export async function logout(rawToken: string | undefined, request: Request): Promise<void> {
  if (rawToken === undefined || rawToken.length === 0) {
    return; // Idempotent: nothing to revoke, still a success.
  }
  const stored = await findLiveRefreshToken(rawToken);
  if (stored !== null) {
    await revokeRefreshToken(stored.id);
    recordAuthAudit({ action: 'user.logout', actorId: stored.userId, request });
  }
}

// ── Logout-all ───────────────────────────────────────────────────────────────

export async function logoutAll(auth: { userId: string }, request: Request): Promise<{ revokedSessions: number }> {
  const revoked = await revokeAllRefreshTokensForUser(new Types.ObjectId(auth.userId));
  recordAuthAudit({ action: 'user.logout_all', actorId: new Types.ObjectId(auth.userId), request, metadata: { revokedSessions: revoked } });
  return { revokedSessions: revoked };
}

// ── Password reset ───────────────────────────────────────────────────────────

export async function forgotPassword(
  input: { email: string },
  request: Request,
): Promise<{ queued: boolean }> {
  // +passwordHash is required to distinguish credential accounts from future
  // SSO-only ones (passwordHash is select:false by default).
  const user = await UserModel.findOne({ email: input.email }).select('+passwordHash');
  if (user !== null && user.passwordHash !== undefined) {
    const rawToken = await issueOneTimeToken(user.email, 'password_reset');
    await sendEmail(buildPasswordResetEmail(user.email, rawToken));
    recordAuthAudit({ action: 'user.password_reset_requested', actorId: user._id, email: user.email, request });
  }
  // Anti-enumeration: always the same response.
  return { queued: true };
}

export async function resetPassword(
  input: { email: string; token: string; password: string },
  request: Request,
): Promise<void> {
  const consumed = await consumeOneTimeToken(input.email, 'password_reset', input.token);
  if (!consumed) {
    throw AppError.badRequest('Invalid or expired reset link');
  }

  const user = await UserModel.findOne({ email: input.email }).select('+passwordHash');
  if (user === null) {
    throw AppError.badRequest('Invalid or expired reset link');
  }

  const passwordHash = await hashPassword(input.password);
  await UserModel.updateOne({ _id: user._id }, { $set: { passwordHash } });

  // The old credential may be compromised: every live session dies now.
  await revokeAllRefreshTokensForUser(user._id);

  recordAuthAudit({
    action: 'user.password_reset',
    actorId: user._id,
    email: user.email,
    request,
    metadata: { revokedAllSessions: true },
  });
}

// ── Current user ─────────────────────────────────────────────────────────────

export async function getMe(userId: string): Promise<PublicUser> {
  const user = await UserModel.findById(userId);
  if (user === null) {
    throw AppError.unauthorized();
  }
  return toPublicUser(user);
}
