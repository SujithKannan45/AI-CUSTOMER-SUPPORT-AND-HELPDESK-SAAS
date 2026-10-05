import { Schema, model } from 'mongoose';

import { EMAIL_PATTERN, URL_PATTERN } from '../../database/schema-validators.js';

import { USER_STATUSES, type UserDocument } from './user.types.js';

/**
 * User — platform identity model.
 *
 * Design notes:
 * - NOT tenant-scoped: one human = one account across the whole SaaS. Their
 *   presence in a workspace is expressed by a `WorkspaceMember` document.
 * - `email` is unique globally (identity lookup / login), unlike Customer
 *   emails which are unique only per workspace.
 * - Sensitive paths (`passwordHash`, `tokenVersion`) use `select: false` so a
 *   careless `find()` can never ship them to a client or a log line.
 * - Refresh-token strategy (Prompt 4, prepared): stateless short-lived access
 *   JWTs + rotating refresh tokens persisted hashed in a dedicated collection
 *   (added with auth, NOT embedded here — unbounded arrays are forbidden).
 *   `tokenVersion` is the global kill switch available today.
 */
const userSchema = new Schema<UserDocument>(
  {
    name: {
      type: String,
      required: [true, 'User name is required'],
      trim: true,
      minlength: 1,
      maxlength: 100,
    },
    email: {
      type: String,
      required: [true, 'User email is required'],
      lowercase: true,
      trim: true,
      match: [EMAIL_PATTERN, 'User email is not a valid address'],
      maxlength: 254,
    },
    passwordHash: {
      type: String,
      select: false,
    },
    avatarUrl: {
      type: String,
      maxlength: 2048,
      match: [URL_PATTERN, 'Avatar URL must be an absolute http(s) URL'],
    },
    status: {
      type: String,
      enum: USER_STATUSES,
      default: 'active',
      required: true,
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    lastLoginAt: {
      type: Date,
    },
    tokenVersion: {
      type: Number,
      default: 0,
      select: false,
    },
  },
  { timestamps: true },
);

/**
 * Index strategy: a single unique index on `email` (login lookup + duplicate
 * prevention). Users are queried by id/email only — no tenant index by
 * design (see model docs).
 */
userSchema.index({ email: 1 }, { unique: true, name: 'uniq_user_email' });

export const UserModel = model<UserDocument>('User', userSchema, 'users');
