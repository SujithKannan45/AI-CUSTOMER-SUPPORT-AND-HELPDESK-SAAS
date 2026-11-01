import type { Request } from 'express';
import type { Types } from 'mongoose';

import { AuditLogModel } from '../audit-logs/audit-log.model.js';

/**
 * Audit helper for escalation events — composes on the EXISTING AuditLog
 * collection with the project-wide fire-and-forget convention (a failed
 * append never breaks the user-visible flow and is logged loudly).
 *
 * Actions (dotted taxonomy):
 *   escalation.created / escalation.assigned / escalation.reassigned /
 *   escalation.accepted / escalation.resolved / escalation.cancelled /
 *   escalation.ticket_transitioned / escalation.ticket_transition_skipped
 *
 * NEVER recorded: conversation or ticket content, escalation resolution
 * notes, cancel reasons — only ids, trigger/reason codes and lifecycle
 * states (the compliance trail stays content-free, same law as agent/rag
 * audits). Unsuccessful AI interactions are audited BY the agent module;
 * this helper never logs question text either.
 */
export const ESCALATION_AUDIT_RESOURCE_TYPE = 'escalation' as const;

export const ESCALATION_AUDIT_ACTIONS = {
  created: 'escalation.created',
  assigned: 'escalation.assigned',
  reassigned: 'escalation.reassigned',
  accepted: 'escalation.accepted',
  resolved: 'escalation.resolved',
  cancelled: 'escalation.cancelled',
  ticketTransitioned: 'escalation.ticket_transitioned',
  ticketTransitionSkipped: 'escalation.ticket_transition_skipped',
} as const;

export type EscalationAuditAction = (typeof ESCALATION_AUDIT_ACTIONS)[keyof typeof ESCALATION_AUDIT_ACTIONS];

export interface EscalationAuditInput {
  readonly action: EscalationAuditAction;
  readonly workspaceId: Types.ObjectId;
  /**
   * The acting staff member — never a client value. Null is reserved for the
   * rare system/AI-initiated side effects (the audit log model allows it);
   * every AUTHORIZED endpoint action carries a real actor id.
   */
  readonly actorId: Types.ObjectId | null;
  readonly escalationId: string;
  /** Structured context (trigger, reason codes, field names) — no content. */
  readonly metadata?: Record<string, unknown>;
  readonly request?: Request;
}

export function recordEscalationAudit(input: EscalationAuditInput): void {
  void AuditLogModel.create({
    workspaceId: input.workspaceId,
    ...(input.actorId !== null ? { actorId: input.actorId } : {}),
    action: input.action,
    resourceType: ESCALATION_AUDIT_RESOURCE_TYPE,
    resourceId: input.escalationId,
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
    console.error('[escalation-audit] failed to append audit entry', error);
  });
}
