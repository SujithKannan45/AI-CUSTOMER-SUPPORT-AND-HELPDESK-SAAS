import { Schema, model } from 'mongoose';

import { EMAIL_PATTERN } from '../../database/schema-validators.js';

import { AUTH_TOKEN_PURPOSES, type AuthTokenDocument, type RefreshTokenDocument } from './auth-token.types.js';

/**
 * RefreshToken — one document per active login session (device).
 *
 * Security invariants:
 * - The RAW token value is NEVER persisted. Only `tokenHash` (SHA-256 of the
 *   token) is stored; a database dump cannot be replayed as a session.
 * - Rotation: `refresh()` marks the used token `revokedAt` + `rotatedTo`
 *   before issuing its successor. Reuse of a rotated token is treated as a
 *   credential-leak signal and revokes the entire token family.
 * - `expiresAt` is a hard, index-backed expiry (no sliding sessions).
 * - Unbounded growth is impossible: a user's sessions live in THIS
 *   collection, never embedded in the User document.
 */
const refreshTokenSchema = new Schema<RefreshTokenDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User reference is required'],
    },
    /** SHA-256 hex of the raw token. Raw tokens are never stored or logged. */
    tokenHash: {
      type: String,
      required: [true, 'Token hash is required'],
      select: false,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    /** Set on logout / rotation / reuse-detection / password reset. */
    revokedAt: {
      type: Date,
      default: null,
    },
    /** Successor token id when this token was consumed by rotation. */
    rotatedTo: {
      type: Schema.Types.ObjectId,
      ref: 'RefreshToken',
      default: null,
    },
    /**
     * Token-family id: constant across a rotation chain. Reuse of any member
     * of the family revokes the whole family (detect-theft pattern, RFC 6819).
     */
    familyId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    /** Denormalized request context for the session list / security review. */
    ip: {
      type: String,
      maxlength: 45,
      trim: true,
    },
    userAgent: {
      type: String,
      maxlength: 512,
      trim: true,
    },
    lastUsedAt: {
      type: Date,
    },
  },
  { timestamps: true },
);

/**
 * Index strategy:
 * - `tokenHash` unique + select:false: the ONLY lookup by token value is the
 *   refresh endpoint; the hash is never needed in projections elsewhere.
 * - `{ familyId }`: rotation chains + family-wide revocation.
 * - `{ userId, expiresAt }`: "list active sessions for user" (logout-all,
 *   future session-management UI). TTL-friendly shape.
 */
refreshTokenSchema.index({ tokenHash: 1 }, { unique: true, name: 'uniq_refresh_token_hash' });
refreshTokenSchema.index({ familyId: 1 }, { name: 'idx_refresh_by_family' });
refreshTokenSchema.index({ userId: 1, expiresAt: -1 }, { name: 'idx_refresh_by_user' });

/**
 * AuthToken — generic one-time, hashed, expiring token for email workflows
 * (verify-email, password reset). Colocation in one collection keeps the
 * security properties in one audited place; `purpose` + `email` scope the
 * lookup so a verification token can never be replayed as a reset token.
 */
const authTokenSchema = new Schema<AuthTokenDocument>(
  {
    /**
     * Required for email-bound tokens: the token is only resolvable together
     * with the email submitted in the verify/reset request, so a leaked token
     * alone (e.g. read from server logs, where raw tokens appear ONLY in the
     * dev "log" email outbox) cannot be used without knowing the account.
     */
    email: {
      type: String,
      required: [true, 'Token email is required'],
      lowercase: true,
      trim: true,
      match: [EMAIL_PATTERN, 'Token email is not a valid address'],
    },
    purpose: {
      type: String,
      enum: AUTH_TOKEN_PURPOSES,
      required: true,
    },
    /** SHA-256 hex of the raw token. Raw tokens are never stored. */
    tokenHash: {
      type: String,
      required: [true, 'Token hash is required'],
      select: false,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    /** Set on successful consumption — one-time use is enforced here. */
    consumedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

/**
 * Lookup is always (email, purpose, tokenHash) — the compound unique index
 * prevents duplicate live tokens per (email, purpose) pair, so a new
 * forgot-password request invalidates the previous one naturally by replacing
 * the row. `{ email: 1, purpose: 1 }` with unique is enough for that
 * replacement semantics while lookups add tokenHash as a query filter.
 */
authTokenSchema.index(
  { email: 1, purpose: 1 },
  { unique: true, name: 'uniq_auth_token_email_purpose' },
);
authTokenSchema.index({ expiresAt: 1 }, { name: 'idx_auth_token_expiry' });

export const RefreshTokenModel = model<RefreshTokenDocument>('RefreshToken', refreshTokenSchema, 'refresh_tokens');
export const AuthTokenModel = model<AuthTokenDocument>('AuthToken', authTokenSchema, 'auth_tokens');
