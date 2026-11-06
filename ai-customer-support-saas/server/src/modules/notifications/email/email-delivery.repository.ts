import { type Types , type FilterQuery } from 'mongoose';

import { assertTenantScope, tenantFilter } from '../../../database/tenant.js';
import type { EmailDeliveryDocument, NotificationType } from '../notification.types.js';

import {
  EmailDeliveryModel,
  isDuplicateEmailDeliveryError,
} from './email-delivery.model.js';

/**
 * Email delivery persistence — the ONLY module touching `email_deliveries`.
 *
 * Every query carries the tenant scope (asserted). The SWEEP scans inside one
 * workspace on purpose: this deployment has no worker that enumerates
 * tenants, so a future job iterates workspaces and calls
 * `listDueEmailDeliveryIds(workspaceId)` — no unscoped collection scan exists
 * (and none should be added quietly).
 *
 * Race safety: `claimEmailDelivery` is a single atomic findOneAndUpdate that
 * flips PENDING/RETRY_PENDING → PROCESSING and increments `attempts`. Two
 * sweepers therefore cannot send the same row twice.
 */

export interface CreateEmailDeliveryInput {
  readonly workspaceId: Types.ObjectId;
  readonly recipientId: Types.ObjectId;
  readonly notificationId: Types.ObjectId | null;
  readonly to: string;
  readonly templateKey: NotificationType;
  readonly title: string;
  readonly body: string;
  readonly eventKey: string;
  readonly maxAttempts: number;
}

export interface CreateEmailDeliveryOutcome {
  readonly delivery: EmailDeliveryDocument;
  readonly created: boolean;
}

export async function createEmailDeliveryIfAbsent(
  input: CreateEmailDeliveryInput,
): Promise<CreateEmailDeliveryOutcome | null> {
  const uniqueFilter: FilterQuery<EmailDeliveryDocument> = {
    ...tenantFilter(input.workspaceId),
    eventKey: input.eventKey,
    recipientId: input.recipientId,
  };
  assertTenantScope(uniqueFilter, 'createEmailDeliveryIfAbsent');

  const existing = await EmailDeliveryModel.findOne(uniqueFilter);
  if (existing !== null) return { delivery: existing, created: false };

  try {
    const delivery = await EmailDeliveryModel.create({
      ...tenantFilter(input.workspaceId),
      recipientId: input.recipientId,
      notificationId: input.notificationId,
      to: input.to,
      templateKey: input.templateKey,
      title: input.title,
      body: input.body,
      eventKey: input.eventKey,
      status: 'PENDING',
      attempts: 0,
      maxAttempts: input.maxAttempts,
      nextAttemptAt: null,
    });
    return { delivery, created: true };
  } catch (error: unknown) {
    if (!isDuplicateEmailDeliveryError(error)) throw error;
    const winner = await EmailDeliveryModel.findOne(uniqueFilter);
    return winner === null ? null : { delivery: winner, created: false };
  }
}

/** Atomically takes ownership of a due row (PENDING or RETRY_PENDING). */
export async function claimEmailDelivery(
  workspaceId: Types.ObjectId,
  deliveryId: Types.ObjectId,
): Promise<EmailDeliveryDocument | null> {
  const filter: FilterQuery<EmailDeliveryDocument> = {
    ...tenantFilter(workspaceId),
    _id: deliveryId,
    status: { $in: ['PENDING', 'RETRY_PENDING'] },
  };
  assertTenantScope(filter, 'claimEmailDelivery');

  return EmailDeliveryModel.findOneAndUpdate(
    filter,
    { $set: { status: 'PROCESSING', nextAttemptAt: null }, $inc: { attempts: 1 } },
    { new: true },
  );
}

export async function markEmailDeliverySent(
  workspaceId: Types.ObjectId,
  deliveryId: Types.ObjectId,
  receipt: { readonly provider: string; readonly acceptedAt: Date },
): Promise<void> {
  const filter = { ...tenantFilter(workspaceId), _id: deliveryId };
  assertTenantScope(filter, 'markEmailDeliverySent');
  await EmailDeliveryModel.updateOne(filter, {
    $set: {
      status: 'SENT',
      provider: receipt.provider,
      acceptedAt: receipt.acceptedAt,
      lastErrorCode: null,
      nextAttemptAt: null,
    },
  });
}

export async function markEmailDeliveryUnsuccessful(
  workspaceId: Types.ObjectId,
  deliveryId: Types.ObjectId,
  outcome: {
    readonly status: 'RETRY_PENDING' | 'FAILED';
    readonly errorCode: string;
    readonly nextAttemptAt: Date | null;
    readonly provider: string;
  },
): Promise<void> {
  const filter = { ...tenantFilter(workspaceId), _id: deliveryId };
  assertTenantScope(filter, 'markEmailDeliveryUnsuccessful');
  await EmailDeliveryModel.updateOne(filter, {
    $set: {
      status: outcome.status,
      lastErrorCode: outcome.errorCode,
      nextAttemptAt: outcome.nextAttemptAt,
      provider: outcome.provider,
      acceptedAt: null,
    },
  });
}

/**
 * Due row ids for ONE workspace, oldest attempt first. `PROCESSING` rows are
 * excluded: a crashed attempt stays PROCESSING rather than being re-sent
 * blindly (documented limitation — there is no lease/timeout reaper yet).
 */
export async function listDueEmailDeliveryIds(
  workspaceId: Types.ObjectId,
  limit: number,
): Promise<Types.ObjectId[]> {
  const filter: FilterQuery<EmailDeliveryDocument> = {
    ...tenantFilter(workspaceId),
    status: 'RETRY_PENDING',
    nextAttemptAt: { $lte: new Date() },
  };
  assertTenantScope(filter, 'listDueEmailDeliveryIds');
  const rows = await EmailDeliveryModel.find(filter)
    .sort({ nextAttemptAt: 1, _id: 1 })
    .limit(limit)
    .select('_id');
  return rows.map((row) => row._id);
}

/** Recipient delivery history — verification/forensics (no admin endpoint). */
export async function listEmailDeliveriesForRecipient(
  workspaceId: Types.ObjectId,
  recipientId: Types.ObjectId,
  limit = 20,
): Promise<EmailDeliveryDocument[]> {
  const filter: FilterQuery<EmailDeliveryDocument> = {
    ...tenantFilter(workspaceId),
    recipientId,
  };
  assertTenantScope(filter, 'listEmailDeliveriesForRecipient');
  return EmailDeliveryModel.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit);
}
