import { z } from 'zod';

import {
  NOTIFICATION_ENTITY_TYPES,
  NOTIFICATION_TYPES,
  type NotificationEntityType,
  type NotificationType,
} from './notification.types.js';

/**
 * Notification API validation — strict, allowlisted Zod schemas following the
 * escalation/agent conventions.
 *
 * Deliberate omissions (security by construction):
 * - NO `recipientId` / `userId` anywhere: the recipient is ALWAYS
 *   `req.auth.userId`. A client cannot address another user's inbox or
 *   preferences, so a forged id is not rejected — it does not exist as input.
 * - NO delivery/ledger fields: email status is server-owned.
 * - Unknown keys are rejected (`.strict()`), so a future field cannot be
 *   smuggled in before it is validated.
 */

const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Must be a 24-hex-character ObjectId');

export const notificationWorkspaceParamsSchema = z
  .object({ workspaceId: objectIdSchema })
  .strict();
export interface NotificationWorkspaceParams {
  readonly workspaceId: string;
}

export const notificationParamsSchema = z
  .object({
    workspaceId: objectIdSchema,
    notificationId: objectIdSchema,
  })
  .strict();
export interface NotificationParams {
  readonly workspaceId: string;
  readonly notificationId: string;
}

/** ISO-8601 datetime (offset allowed) — the project's date-input convention. */
const isoDateSchema = z.string().trim().datetime({ offset: true });

/**
 * Inbox listing (Prompt 17 added search + creation-date filters). The
 * recipient is STRUCTURALLY absent: it is always `req.auth.userId`, so no
 * query value can address another user's inbox. `sort` is deliberately not
 * offered — newest-first is the inbox's semantic order, not a preference.
 */
export const listNotificationsQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    /** `true` = unread only (the badge/dropdown view). */
    unread: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    type: z.enum(NOTIFICATION_TYPES).optional(),
    entityType: z.enum(NOTIFICATION_ENTITY_TYPES).optional(),
    entityId: objectIdSchema.optional(),
    /** Literal substring over the caller's notification title/body. */
    search: z.string().trim().min(1).max(100).optional(),
    createdFrom: isoDateSchema.optional(),
    createdTo: isoDateSchema.optional(),
  })
  .strict()
  .refine(
    (query) =>
      query.createdFrom === undefined ||
      query.createdTo === undefined ||
      new Date(query.createdFrom).getTime() <= new Date(query.createdTo).getTime(),
    { message: 'createdFrom must not be after createdTo', path: ['createdFrom'] },
  );
export interface ListNotificationsQuery {
  readonly page: number;
  readonly limit: number;
  readonly unread: boolean;
  readonly type?: NotificationType;
  readonly entityType?: NotificationEntityType;
  readonly entityId?: string;
  readonly search?: string;
  readonly createdFrom?: string;
  readonly createdTo?: string;
}

/**
 * Preference patch — every field optional, at least one required. Boolean-only
 * (no coercion from strings) so a typo cannot silently mute a channel.
 */
export const updateNotificationPreferencesSchema = z
  .object({
    inAppEnabled: z.boolean().optional(),
    emailEnabled: z.boolean().optional(),
    ticketAssignment: z.boolean().optional(),
    ticketUpdates: z.boolean().optional(),
    publicReplies: z.boolean().optional(),
    escalations: z.boolean().optional(),
    aiHandoff: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one preference to update',
  });
export type UpdateNotificationPreferencesInput = z.infer<
  typeof updateNotificationPreferencesSchema
>;
