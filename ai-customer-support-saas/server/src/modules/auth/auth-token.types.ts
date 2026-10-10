import type { Document, Types } from 'mongoose';

/** One-time token workflows. New purposes must be added here + handled in the service. */
export const AUTH_TOKEN_PURPOSES = ['verify_email', 'password_reset'] as const;
export type AuthTokenPurpose = (typeof AUTH_TOKEN_PURPOSES)[number];

/**
 * One row per active login session. The raw refresh token exists only at the
 * moment of issuance (cookie/JSON); the database holds only its SHA-256 hash.
 */
export interface RefreshTokenDocument extends Document<Types.ObjectId> {
  userId: Types.ObjectId;
  /** SHA-256 hex of the raw token — never the token itself. */
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  rotatedTo: Types.ObjectId | null;
  /** Rotation-chain family id (constant across the chain). */
  familyId: Types.ObjectId;
  ip?: string;
  userAgent?: string;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** One-time, hashed, expiring token for an email workflow. */
export interface AuthTokenDocument extends Document<Types.ObjectId> {
  email: string;
  purpose: AuthTokenPurpose;
  /** SHA-256 hex of the raw token — never the token itself. */
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}
