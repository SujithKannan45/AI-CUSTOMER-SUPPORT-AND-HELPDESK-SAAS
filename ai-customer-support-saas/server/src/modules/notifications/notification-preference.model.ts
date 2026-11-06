import { Schema, model } from 'mongoose';

import type { NotificationPreferenceDocument } from './notification.types.js';

/**
 * NotificationPreference — one row per (workspace, user).
 *
 * The compound UNIQUE index (not service logic) is what guarantees "one
 * preference record per user per workspace" even under concurrent first
 * writes: `getNotificationPreferences` upserts with `$setOnInsert`, so a race
 * loses safely against the index and re-reads the winner.
 *
 * Defaults are defined HERE (schema) and mirrored by
 * `DEFAULT_NOTIFICATION_PREFERENCES` in notification.preferences.ts — the
 * service always resolves through the constant, so the two cannot drift
 * silently (the model test asserts equality).
 *
 * No team-level preferences: this repository has no team entity, so per-user
 * (workspace-scoped) is the honest granularity.
 */
const notificationPreferenceSchema = new Schema<NotificationPreferenceDocument>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: [true, 'Workspace reference is required'],
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User reference is required'],
    },
    inAppEnabled: { type: Boolean, default: true, required: true },
    emailEnabled: { type: Boolean, default: true, required: true },
    ticketAssignment: { type: Boolean, default: true, required: true },
    ticketUpdates: { type: Boolean, default: true, required: true },
    publicReplies: { type: Boolean, default: true, required: true },
    escalations: { type: Boolean, default: true, required: true },
    aiHandoff: { type: Boolean, default: true, required: true },
  },
  { timestamps: true },
);

notificationPreferenceSchema.index(
  { workspaceId: 1, userId: 1 },
  { unique: true, name: 'uniq_preference_per_member' },
);

export const NotificationPreferenceModel = model<NotificationPreferenceDocument>(
  'NotificationPreference',
  notificationPreferenceSchema,
  'notification_preferences',
);
