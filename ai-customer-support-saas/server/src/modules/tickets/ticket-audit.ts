import type { Request } from 'express';
import type { Types } from 'mongoose';

import { AuditLogModel } from '../audit-logs/audit-log.model.js';

/**
 * Audit helper for ticket events — composes on the EXISTING AuditLog
 * collection (same fire-and-forget pattern as auth-audit / workspace-audit /
 * customer-audit: a failed audit append never breaks the user-visible flow).
 *
 * Actions recorded by the ticket module (dotted taxonomy):
 *   ticket.created, ticket.updated, ticket.status_changed,
 *   ticket.assigned, ticket.unassigned, ticket.priority_changed,
 *   ticket.resolved, ticket.reopened, ticket.archived
 *
 * NEVER recorded: descriptions, resolution notes, subjects or any customer
 * PII — lifecycle changes are audited with from→to STATUS/PRIORITY/ASSIGNEE
 * ids and field NAMES only, so the trail documents who moved what without
 * duplicating content into the audit log.
 */
export const TICKET_AUDIT_ACTIONS = {
  created: 'ticket.created',
  updated: 'ticket.updated',
  statusChanged: 'ticket.status_changed',
  assigned: 'ticket.assigned',
  unassigned: 'ticket.unassigned',
  priorityChanged: 'ticket.priority_changed',
  resolved: 'ticket.resolved',
  reopened: 'ticket.reopened',
  archived: 'ticket.archived',
} as const;

export type TicketAuditAction =
  (typeof TICKET_AUDIT_ACTIONS)[keyof typeof TICKET_AUDIT_ACTIONS];

export interface TicketAuditInput {
  readonly action: TicketAuditAction;
  readonly workspaceId: Types.ObjectId;
  readonly actorId: Types.ObjectId;
  readonly ticketId: string;
  /** Structured context (state names/ids, field names) — never ticket content. */
  readonly metadata?: Record<string, unknown>;
  readonly request?: Request;
}

export function recordTicketAudit(input: TicketAuditInput): void {
  void AuditLogModel.create({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: input.action,
    resourceType: 'ticket',
    resourceId: input.ticketId,
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
    console.error('[ticket-audit] failed to append audit entry', error);
  });
}
