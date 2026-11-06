import type { Request } from 'express';
import type { Types } from 'mongoose';

import { AuditLogModel } from '../audit-logs/audit-log.model.js';

/**
 * Notification audit (Prompt 16 §11) — composes on the EXISTING AuditLog
 * collection with the project-wide fire-and-forget convention.
 *
 * What is audited: PREFERENCE CHANGES only (`notification.preferences_updated`).
 * Rationale: per-notification rows would double the write volume of every
 * ticket event for no compliance value — a notification is derived data whose
 * durable record is the domain entity + its own audit entry.
 *
 * What is NEVER recorded: notification titles/bodies, recipient addresses,
 * email subjects, rendered email content, provider errors, or the delivery
 * ledger. Only the field NAMES that changed.
 */
export const NOTIFICATION_AUDIT_RESOURCE_TYPE = 'notification_preferences' as const;

export const NOTIFICATION_AUDIT_ACTIONS = {
  preferencesUpdated: 'notification.preferences_updated',
} as const;

export interface NotificationAuditInput {
  readonly action: (typeof NOTIFICATION_AUDIT_ACTIONS)[keyof typeof NOTIFICATION_AUDIT_ACTIONS];
  readonly workspaceId: Types.ObjectId;
  /** The authenticated user whose preferences changed (never client-supplied). */
  readonly actorId: Types.ObjectId;
  readonly metadata?: Record<string, unknown>;
  readonly request?: Request;
}

export function recordNotificationAudit(input: NotificationAuditInput): void {
  void AuditLogModel.create({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: input.action,
    resourceType: NOTIFICATION_AUDIT_RESOURCE_TYPE,
    resourceId: input.actorId.toHexString(),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    ...(input.request !== undefined
      ? {
          ip: input.request.ip,
          userAgent:
            typeof input.request.headers['user-agent'] === 'string'
              ? input.request.headers['user-agent'].slice(0, 512)
              : undefined,
        }
      : {}),
  }).catch((error: unknown) => {
    // eslint-disable-next-line no-console -- terminal failure path (same rationale as agent-audit)
    console.error('[notification-audit] failed to append audit entry', error);
  });
}
