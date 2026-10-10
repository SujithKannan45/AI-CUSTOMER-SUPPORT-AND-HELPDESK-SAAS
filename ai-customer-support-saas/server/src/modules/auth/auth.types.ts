import type { Types } from 'mongoose';

/**
 * Safe authenticated-user context attached to requests by `requireAuth`.
 *
 * Deliberately minimal — authentication owns ONLY identity. Workspace ids,
 * roles and permissions are authorization concerns and arrive in later
 * prompts via workspace middleware that composes with this context
 * (`req.auth.workspaceId` etc.), never by widening this type.
 */
export interface AuthUser {
  /** User id (string form of the JWT `sub`). */
  readonly userId: string;
}

/** Augments the typed authenticated-request context (see requireAuth). */
declare module 'express-serve-static-core' {
  interface Request {
    /** Present only after `requireAuth` succeeded. */
    auth?: AuthUser;
  }
}

/** Public (client-safe) user profile — the ONLY user shape ever returned by auth endpoints. */
export interface PublicUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly avatarUrl?: string;
  readonly status: string;
  readonly emailVerified: boolean;
  readonly lastLoginAt?: string;
  readonly createdAt: string;
}

export interface AuthTokensPayload {
  /** Short-lived JWT for Authorization: Bearer headers. */
  readonly accessToken: string;
  /** Seconds until the access token expires. */
  readonly expiresIn: number;
  /** Whether the refresh token is ALSO available as an HttpOnly cookie (it is always in the JSON body too — see module docs). */
  readonly refreshInCookie: boolean;
}

export interface AuthSuccessPayload {
  readonly user: PublicUser;
  readonly tokens: AuthTokensPayload;
}

/** Shape of RefreshToken documents keyed by id (future session-management UI). */
export interface SessionSummary {
  readonly id: Types.ObjectId;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastUsedAt?: Date;
  readonly ip?: string;
  readonly userAgent?: string;
}
