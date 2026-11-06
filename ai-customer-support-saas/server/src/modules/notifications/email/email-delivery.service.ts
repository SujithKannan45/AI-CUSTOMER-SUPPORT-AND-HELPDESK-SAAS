import type { Types } from 'mongoose';

import { env } from '../../../config/env.config.js';
import { logger } from '../../../core/logger/logger.js';
import { findActiveUserContact } from '../../users/user.repository.js';
import { findWorkspaceById } from '../../workspaces/workspace.repository.js';
import type { EmailDeliveryStatus, NotificationType } from '../notification.types.js';

import {
  claimEmailDelivery,
  createEmailDeliveryIfAbsent,
  listDueEmailDeliveryIds,
  markEmailDeliverySent,
  markEmailDeliveryUnsuccessful,
} from './email-delivery.repository.js';
import { resolveEmailProvider } from './email.factory.js';
import { renderNotificationEmail } from './email.templates.js';
import { EmailProviderError } from './email.types.js';

/**
 * Email delivery orchestration — the ONE place that decides "send, retry or
 * give up".
 *
 * Reliability honesty (read this before changing anything):
 * - The delivery row is persisted BEFORE the provider is contacted, so a crash
 *   cannot lose the fact that an email was owed.
 * - Delivery is attempted INLINE (one bounded attempt per event). There is no
 *   queue and no background worker in this deployment (Redis/BullMQ was never
 *   installed — Prompt 12 dependency). A failed attempt leaves a
 *   `RETRY_PENDING` row with a backoff timestamp that only advances when
 *   `sweepEmailDeliveries()` is invoked by an operator/cron entry point.
 *   Nothing here spawns a timer or an unowned loop.
 * - `SENT` means the provider ACCEPTED the message. There is no delivery
 *   webhook, bounce processing or exactly-once guarantee, and this module
 *   never claims one.
 * - A provider failure NEVER propagates into the caller's business operation:
 *   the dispatcher invokes this module fire-and-forget, and every outcome is
 *   recorded on the ledger.
 */

const MAX_BACKOFF_MS = 60 * 60 * 1000;

export interface NotificationEmailRequest {
  readonly workspaceId: Types.ObjectId;
  readonly recipientId: Types.ObjectId;
  readonly notificationId: Types.ObjectId | null;
  readonly type: NotificationType;
  readonly eventKey: string;
  readonly title: string;
  readonly body: string;
}

export interface EmailDeliveryOutcome {
  /** True when this call created the ledger row (a duplicate event does not). */
  readonly queued: boolean;
  readonly status: EmailDeliveryStatus | null;
  /** Provider accepted the message during THIS call (not delivery proof). */
  readonly accepted: boolean;
}

export function isNotificationEmailEnabled(): boolean {
  return env.NOTIFICATION_EMAIL_ENABLED === 'true';
}

function backoffFor(attempts: number): Date {
  const exponential = env.NOTIFICATION_EMAIL_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);
  return new Date(Date.now() + Math.min(exponential, MAX_BACKOFF_MS));
}

/**
 * Enqueue (idempotently) and attempt ONE delivery for a notification event.
 * Never throws: email is best-effort by contract.
 */
export async function deliverNotificationEmail(
  request: NotificationEmailRequest,
): Promise<EmailDeliveryOutcome> {
  if (!isNotificationEmailEnabled()) {
    return { queued: false, status: null, accepted: false };
  }

  const contact = await findActiveUserContact(request.recipientId);
  if (contact === null) {
    // Suspended/deleted identity: nothing to send to, nothing to record.
    logger.debug(
      { recipientId: request.recipientId.toHexString(), type: request.type },
      'notification email skipped — recipient is not an active user',
    );
    return { queued: false, status: null, accepted: false };
  }

  const enqueued = await createEmailDeliveryIfAbsent({
    workspaceId: request.workspaceId,
    recipientId: request.recipientId,
    notificationId: request.notificationId,
    to: contact.email,
    templateKey: request.type,
    title: request.title,
    body: request.body,
    eventKey: request.eventKey,
    maxAttempts: env.NOTIFICATION_EMAIL_MAX_ATTEMPTS,
  });
  if (enqueued === null) {
    return { queued: false, status: null, accepted: false };
  }

  // A row that already succeeded (or is being attempted) must not be re-sent:
  // that is the duplicate-email law for retried domain events.
  if (!enqueued.created && enqueued.delivery.status !== 'RETRY_PENDING') {
    return { queued: false, status: enqueued.delivery.status, accepted: false };
  }

  const status = await attemptEmailDelivery(request.workspaceId, enqueued.delivery._id);
  return { queued: enqueued.created, status, accepted: status === 'SENT' };
}

/**
 * One claimed attempt for one ledger row. Returns the resulting status (null
 * when the row was already claimed by a concurrent attempt). Never throws.
 */
export async function attemptEmailDelivery(
  workspaceId: Types.ObjectId,
  deliveryId: Types.ObjectId,
): Promise<EmailDeliveryStatus | null> {
  const delivery = await claimEmailDelivery(workspaceId, deliveryId);
  if (delivery === null) return null; // another attempt owns it / already terminal

  const provider = resolveEmailProvider();

  if (delivery.attempts > delivery.maxAttempts) {
    await markEmailDeliveryUnsuccessful(workspaceId, delivery._id, {
      status: 'FAILED',
      errorCode: 'EMAIL_ATTEMPTS_EXHAUSTED',
      nextAttemptAt: null,
      provider: provider.name,
    });
    return 'FAILED';
  }

  const [contact, workspace] = await Promise.all([
    findActiveUserContact(delivery.recipientId),
    findWorkspaceById(workspaceId),
  ]);
  if (contact === null || workspace === null) {
    await markEmailDeliveryUnsuccessful(workspaceId, delivery._id, {
      status: 'FAILED',
      errorCode: contact === null ? 'EMAIL_RECIPIENT_UNAVAILABLE' : 'EMAIL_WORKSPACE_UNAVAILABLE',
      nextAttemptAt: null,
      provider: provider.name,
    });
    return 'FAILED';
  }

  const rendered = renderNotificationEmail({
    templateKey: delivery.templateKey,
    workspaceName: workspace.name,
    recipientName: contact.name,
    title: delivery.title,
    body: delivery.body,
  });

  try {
    const receipt = await provider.send({
      to: delivery.to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      templateKey: delivery.templateKey,
    });
    await markEmailDeliverySent(workspaceId, delivery._id, {
      provider: provider.name,
      acceptedAt: receipt.acceptedAt,
    });
    return 'SENT';
  } catch (error: unknown) {
    const normalized =
      error instanceof EmailProviderError
        ? error
        : new EmailProviderError(
            'EMAIL_PROVIDER_UNEXPECTED',
            'Unexpected email provider failure',
            true,
          );

    const canRetry = normalized.transient && delivery.attempts < delivery.maxAttempts;
    const status: EmailDeliveryStatus = canRetry ? 'RETRY_PENDING' : 'FAILED';
    await markEmailDeliveryUnsuccessful(workspaceId, delivery._id, {
      status,
      errorCode: normalized.code,
      nextAttemptAt: canRetry ? backoffFor(delivery.attempts) : null,
      provider: provider.name,
    });

    // Metadata only: no addresses, no bodies, no provider stack traces.
    logger.warn(
      {
        deliveryId: delivery._id.toHexString(),
        templateKey: delivery.templateKey,
        errorCode: normalized.code,
        attempts: delivery.attempts,
        status,
      },
      'notification email delivery failed',
    );
    return status;
  }
}

export interface SweepResult {
  readonly attempted: number;
  readonly accepted: number;
  readonly retried: number;
  readonly failed: number;
}

/**
 * Drains due retries for ONE workspace. This is the documented entry point a
 * future cron/worker calls; invoking it is explicit, never automatic.
 */
export async function sweepEmailDeliveries(
  workspaceId: Types.ObjectId,
  limit = 20,
): Promise<SweepResult> {
  const dueIds = await listDueEmailDeliveryIds(workspaceId, limit);
  let accepted = 0;
  let retried = 0;
  let failed = 0;

  for (const id of dueIds) {
    const status = await attemptEmailDelivery(workspaceId, id);
    if (status === 'SENT') accepted += 1;
    else if (status === 'RETRY_PENDING') retried += 1;
    else if (status === 'FAILED') failed += 1;
  }

  return { attempted: dueIds.length, accepted, retried, failed };
}
