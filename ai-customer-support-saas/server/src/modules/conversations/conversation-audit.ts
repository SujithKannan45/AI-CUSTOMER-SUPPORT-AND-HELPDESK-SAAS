import type { Request } from 'express';
import type { Types } from 'mongoose';

import { AuditLogModel } from '../audit-logs/audit-log.model.js';

/**
 * Audit helper for conversation/message events — composes on the EXISTING
 * AuditLog collection under the same fire-and-forget convention as
 * auth/workspace/customer/ticket audits: a failed append is logged,
 * never breaks (or silently replaces) the user-visible flow.
 *
 * Actions recorded by this module:
 *   conversation.created   — primary conversation materialized for a ticket
 *   message.created        — a PUBLIC reply or an INTERNAL note was sent
 *   message.edited         — a sender-only, body-only edit happened
 *
 * NEVER recorded: message bodies, subjects, resolution notes, customer PII
 * or any token/credential — metadata carries visibility names and reference
 * ids only, so the trail documents who moved what without duplicating
 * content into the audit log.
 */
export const CONVERSATION_AUDIT_ACTIONS = {
  conversationCreated: 'conversation.created',
  messageCreated: 'message.created',
  messageEdited: 'message.edited',
} as const;

export type ConversationAuditAction =
  (typeof CONVERSATION_AUDIT_ACTIONS)[keyof typeof CONVERSATION_AUDIT_ACTIONS];

export interface ConversationAuditInput {
  readonly action: ConversationAuditAction;
  readonly workspaceId: Types.ObjectId;
  readonly actorId: Types.ObjectId;
  /** Hex id of the conversation/message resource the action targets. */
  readonly targetId: string;
  /** `conversation` or `message` — matches resourceType values of AuditLog. */
  readonly resourceType: 'conversation' | 'message';
  /** Structured context (visibility names, reference ids) — never content. */
  readonly metadata?: Record<string, unknown>;
  readonly request?: Request;
}

export function recordConversationAudit(input: ConversationAuditInput): void {
  void AuditLogModel.create({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.targetId,
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
    // eslint-disable-next-line no-console -- terminal failure path (same rationale as ticket-audit)
    console.error('[conversation-audit] failed to append audit entry', error);
  });
}
