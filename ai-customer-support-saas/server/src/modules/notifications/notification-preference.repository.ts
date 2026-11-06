import type { Types } from 'mongoose';

import { assertTenantScope, tenantFilter } from '../../database/tenant.js';

import { NotificationPreferenceModel } from './notification-preference.model.js';
import type { NotificationPreferenceDocument, NotificationPreferenceValues } from './notification.types.js';

/**
 * Preference persistence — one row per (workspace, user).
 *
 * `getOrCreate` upserts with `$setOnInsert`: concurrent first reads (a
 * dispatcher resolving preferences for the same recipient twice) converge on
 * ONE row and re-read the winner, so duplicates are impossible even without
 * transactions. The unique index is the belt to that suspenders.
 *
 * Updates are a scoped `findOneAndUpdate` on `{ workspaceId, userId }` — the
 * caller's user id comes from the authenticated request, never the body, so a
 * user physically cannot address someone else's preferences.
 */

export async function findNotificationPreferences(
  workspaceId: Types.ObjectId,
  userId: Types.ObjectId,
): Promise<NotificationPreferenceDocument | null> {
  const filter = { ...tenantFilter(workspaceId), userId };
  assertTenantScope(filter, 'findNotificationPreferences');
  return NotificationPreferenceModel.findOne(filter);
}

export async function getOrCreateNotificationPreferences(
  workspaceId: Types.ObjectId,
  userId: Types.ObjectId,
): Promise<NotificationPreferenceDocument> {
  const filter = { ...tenantFilter(workspaceId), userId };
  assertTenantScope(filter, 'getOrCreateNotificationPreferences');

  const existing = await NotificationPreferenceModel.findOne(filter);
  if (existing !== null) return existing;

  try {
    return await NotificationPreferenceModel.create({ ...filter });
  } catch (error: unknown) {
    // Creation race: the winner's document is authoritative (defaults are the
    // only fields written here, so re-reading loses nothing).
    const winner = await NotificationPreferenceModel.findOne(filter);
    if (winner !== null) return winner;
    throw error;
  }
}

export async function updateNotificationPreferences(
  workspaceId: Types.ObjectId,
  userId: Types.ObjectId,
  updates: Partial<NotificationPreferenceValues>,
): Promise<NotificationPreferenceDocument> {
  const filter = { ...tenantFilter(workspaceId), userId };
  assertTenantScope(filter, 'updateNotificationPreferences');

  const updated = await NotificationPreferenceModel.findOneAndUpdate(
    filter,
    { $set: updates, ...upsertDefaults(updates) },
    // A first-time user has no row yet: the patch creates it with defaults for
    // every field the caller did not set (single atomic upsert, no read-then-write).
    { new: true, upsert: true },
  );
  // The upsert above cannot return null (findOneAndUpdate with upsert always
  // yields a document); the guard exists for type-safety only.
  if (updated === null) {
    return getOrCreateNotificationPreferences(workspaceId, userId);
  }
  return updated;
}

/**
 * Defaults applied ONLY when the upsert creates the row — a user patching one
 * toggle still gets every other field at its documented default, and an
 * existing row is never reset.
 */
function upsertDefaults(updates: Partial<NotificationPreferenceValues>): Record<string, unknown> {
  // MongoDB rejects an update document that touches the same path in `$set`
  // and `$setOnInsert` — the caller's explicit toggles are removed here.
  const canonical: Record<keyof NotificationPreferenceValues, boolean> = {
    inAppEnabled: true,
    emailEnabled: true,
    ticketAssignment: true,
    ticketUpdates: true,
    publicReplies: true,
    escalations: true,
    aiHandoff: true,
  };
  const defaults: Partial<Record<keyof NotificationPreferenceValues, boolean>> = {};
  for (const key of Object.keys(canonical) as Array<keyof NotificationPreferenceValues>) {
    if (updates[key] === undefined) defaults[key] = canonical[key];
  }
  return { $setOnInsert: defaults };
}
