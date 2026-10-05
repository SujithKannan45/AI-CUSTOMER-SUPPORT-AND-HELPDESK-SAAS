import type { Document, Types } from 'mongoose';

/** Account lifecycle. */
export const USER_STATUSES = ['active', 'invited', 'suspended'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * Platform identity — deliberately NOT tenant-scoped.
 *
 * A user is a global SaaS identity that can belong to many workspaces; the
 * per-workspace relationship (and role) lives in the `WorkspaceMember`
 * collection. Do not add `workspaceId` here: that would glue one identity to
 * one tenant and force duplicate accounts.
 */
export interface UserDocument extends Document<Types.ObjectId> {
  name: string;
  /** Platform-unique login identifier (lowercased, trimmed). */
  email: string;
  /**
   * Bcrypt/argon hash — never a plaintext password. `select: false` in the
   * schema so normal queries never carry it; auth code must opt in with
   * `.select('+passwordHash')`. Nullable to leave room for future SSO-only
   * accounts that have no local credential.
   */
  passwordHash?: string;
  avatarUrl?: string;
  status: UserStatus;
  emailVerified: boolean;
  lastLoginAt?: Date;
  /**
   * Global token-revocation lever for Prompt 4: bumping it invalidates every
   * previously issued JWT/refresh token for this user. Stored with
   * `select: false` — only the auth layer needs it.
   */
  tokenVersion: number;
  createdAt: Date;
  updatedAt: Date;
}
