import type { Request } from 'express';
import type { Types } from 'mongoose';

import { AuditLogModel } from '../audit-logs/audit-log.model.js';

/**
 * Audit helper for customer events — composes on the EXISTING AuditLog
 * collection (same fire-and-forget pattern as auth-audit / workspace-audit /
 * rbac-audit: a failed audit append never breaks the user-visible flow).
 *
 * Actions recorded by the customer module (dotted taxonomy):
 *   customer.created, customer.updated, customer.archived, customer.restored
 *
 * NEVER recorded: customer names, emails, phones, avatar URLs or metadata
 * values — mutations are audited by FIELD NAME only, so the trail documents
 * who touched which customer without duplicating PII into the audit log.
 */
export const CUSTOMER_AUDIT_ACTIONS = {
  created: 'customer.created',
  updated: 'customer.updated',
  archived: 'customer.archived',
  restored: 'customer.restored',
} as const;

export interface CustomerAuditInput {
  readonly action: (typeof CUSTOMER_AUDIT_ACTIONS)[keyof typeof CUSTOMER_AUDIT_ACTIONS];
  readonly workspaceId: Types.ObjectId;
  readonly actorId: Types.ObjectId;
  readonly customerId: string;
  /** Field NAMES that changed — never values. */
  readonly metadata?: Record<string, unknown>;
  readonly request?: Request;
}

export function recordCustomerAudit(input: CustomerAuditInput): void {
  void AuditLogModel.create({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: input.action,
    resourceType: 'customer',
    resourceId: input.customerId,
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
    // eslint-disable-next-line no-console -- terminal failure path (same rationale as auth-audit)
    console.error('[customer-audit] failed to append audit entry', error);
  });
}
