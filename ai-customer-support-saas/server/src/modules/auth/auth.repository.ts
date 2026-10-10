import { Types } from 'mongoose';

import { AuthTokenModel, RefreshTokenModel } from './auth-token.model.js';
import type { AuthTokenPurpose } from './auth-token.types.js';
import {
  generateOpaqueToken,
  hashToken,
  PASSWORD_RESET_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  VERIFY_EMAIL_TTL_SECONDS,
} from './auth.tokens.js';

/**
 * Persistence for refresh sessions and one-time email tokens.
 *
 * Rules enforced here (services cannot bypass them):
 * - Raw token values NEVER touch the database — only SHA-256 hashes.
 * - Refresh lookups include `revokedAt: null` and `expiresAt: { $gt: now }`,
 *   so an expired/revoked token is indistinguishable from a missing one.
 * - One-time tokens are consumed atomically: the consume update matches ONLY
 *   unconsumed, unexpired documents, so two concurrent verifications cannot
 *   both succeed.
 */

export interface IssuedRefreshRecord {
  /** Raw token — returned exactly once to the caller (cookie/JSON). */
  readonly rawToken: string;
  readonly id: Types.ObjectId;
  readonly familyId: Types.ObjectId;
  readonly expiresAt: Date;
}

export interface CreateRefreshInput {
  userId: Types.ObjectId;
  familyId?: Types.ObjectId;
  ip?: string;
  userAgent?: string;
}

/** Issues (persists) a new refresh session token; returns the raw token once. */
export async function createRefreshToken(input: CreateRefreshInput): Promise<IssuedRefreshRecord> {
  const rawToken = generateOpaqueToken();
  const familyId = input.familyId ?? new Types.ObjectId();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);

  const doc = await RefreshTokenModel.create({
    userId: input.userId,
    tokenHash: hashToken(rawToken),
    expiresAt,
    familyId,
    ...(input.ip !== undefined ? { ip: input.ip } : {}),
    ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
  });

  return { rawToken, id: doc._id, familyId, expiresAt };
}

export interface StoredRefreshToken {
  id: Types.ObjectId;
  userId: Types.ObjectId;
  familyId: Types.ObjectId;
  revokedAt: Date | null;
  rotatedTo: Types.ObjectId | null;
  expiresAt: Date;
}

/**
 * Finds a live (unrevoked, unexpired) refresh session by its raw token.
 * Returns null for unknown, revoked, or expired tokens alike.
 */
export async function findLiveRefreshToken(rawToken: string): Promise<StoredRefreshToken | null> {
  const tokenHash = hashToken(rawToken);
  const doc = await RefreshTokenModel.findOne({ tokenHash }).select('+tokenHash');
  if (doc === null) return null;
  if (doc.revokedAt !== null || doc.expiresAt.getTime() <= Date.now()) return null;
  return {
    id: doc._id,
    userId: doc.userId,
    familyId: doc.familyId,
    revokedAt: doc.revokedAt,
    rotatedTo: doc.rotatedTo,
    expiresAt: doc.expiresAt,
  };
}

/** Marks one refresh token revoked (logout). Idempotent: already-revoked docs match nothing. */
export async function revokeRefreshToken(id: Types.ObjectId): Promise<void> {
  await RefreshTokenModel.updateOne(
    { _id: id, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

/** Revokes every live refresh token of a user (logout-all / password reset). */
export async function revokeAllRefreshTokensForUser(userId: Types.ObjectId): Promise<number> {
  const result = await RefreshTokenModel.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
  return result.modifiedCount;
}

/** Revokes an entire token family (refresh-token reuse/theft response). */
export async function revokeTokenFamily(familyId: Types.ObjectId): Promise<void> {
  await RefreshTokenModel.updateMany(
    { familyId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

/** Marks a token as rotated and links its successor (single doc, atomic). */
export async function markRotated(id: Types.ObjectId, successorId: Types.ObjectId): Promise<void> {
  await RefreshTokenModel.updateOne(
    { _id: id, revokedAt: null },
    { $set: { revokedAt: new Date(), rotatedTo: successorId, lastUsedAt: new Date() } },
  );
}

/** Touches lastUsedAt on refresh (session freshness metadata). */
export async function touchRefreshToken(id: Types.ObjectId): Promise<void> {
  await RefreshTokenModel.updateOne({ _id: id }, { $set: { lastUsedAt: new Date() } });
}

/** Lists live sessions for a user (logout-all feedback, future session UI). */
export async function countLiveSessionsForUser(userId: Types.ObjectId): Promise<number> {
  return RefreshTokenModel.countDocuments({ userId, revokedAt: null, expiresAt: { $gt: new Date() } });
}

// ── One-time email tokens (verify-email / password-reset) ────────────────────

function oneTimeTtlSeconds(purpose: AuthTokenPurpose): number {
  return purpose === 'verify_email' ? VERIFY_EMAIL_TTL_SECONDS : PASSWORD_RESET_TTL_SECONDS;
}

/**
 * Issues a one-time token for (email, purpose). Any previous live token for
 * the same pair is replaced (upsert), so earlier links stop working the
 * moment a new one is generated.
 *
 * Returns the RAW token — the caller must only deliver it via the email
 * transport; it is never logged, never returned in an API response.
 */
export async function issueOneTimeToken(
  email: string,
  purpose: AuthTokenPurpose,
): Promise<string> {
  const rawToken = generateOpaqueToken();
  await AuthTokenModel.findOneAndUpdate(
    { email, purpose },
    {
      $set: {
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + oneTimeTtlSeconds(purpose) * 1000),
        consumedAt: null,
      },
      $setOnInsert: { email, purpose },
    },
    { upsert: true },
  );
  return rawToken;
}

/**
 * Atomically consumes a one-time token: only an unconsumed, unexpired token
 * matching (email, purpose, hash) is marked consumed. Returns false when the
 * token is unknown, expired, already used, or bound to a different email.
 */
export async function consumeOneTimeToken(
  email: string,
  purpose: AuthTokenPurpose,
  rawToken: string,
): Promise<boolean> {
  const result = await AuthTokenModel.findOneAndUpdate(
    {
      email,
      purpose,
      tokenHash: hashToken(rawToken),
      consumedAt: null,
      expiresAt: { $gt: new Date() },
    },
    { $set: { consumedAt: new Date() } },
  );
  return result !== null;
}

/** Deletes consumed/expired one-time tokens (housekeeping). */
export async function purgeStaleOneTimeTokens(): Promise<void> {
  await AuthTokenModel.deleteMany({
    $or: [{ consumedAt: { $ne: null } }, { expiresAt: { $lte: new Date() } }],
  });
}


