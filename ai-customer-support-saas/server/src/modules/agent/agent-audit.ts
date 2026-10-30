import type { Request } from 'express';
import type { Types } from 'mongoose';

import { AuditLogModel } from '../audit-logs/audit-log.model.js';

/**
 * Audit helper for agent events — composes on the EXISTING AuditLog
 * collection with the same fire-and-forget convention as rag-audit:
 * a failed append never breaks the user-visible flow and is logged loudly.
 *
 * Action: agent.question_answered
 *
 * NEVER recorded: the question, the answer, passage text, prompts — only
 * id, outcome codes, counts and truncated status metadata (the compliance
 * trail stays content-free). Token usage is recorded ONLY when the provider
 * actually returned it.
 */
export const AGENT_AUDIT_RESOURCE_TYPE = 'agent_response' as const;

export const AGENT_AUDIT_ACTIONS = {
  questionAnswered: 'agent.question_answered',
} as const;

export type AgentAuditAction = (typeof AGENT_AUDIT_ACTIONS)[keyof typeof AGENT_AUDIT_ACTIONS];

export interface AgentAuditInput {
  readonly action: AgentAuditAction;
  readonly workspaceId: Types.ObjectId;
  readonly actorId: Types.ObjectId;
  readonly resourceId: string;
  /** Structured context — outcome, abstention reason, counts. No content. */
  readonly metadata?: Record<string, unknown>;
  readonly request?: Request;
}

export function recordAgentAudit(input: AgentAuditInput): void {
  void AuditLogModel.create({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: input.action,
    resourceType: AGENT_AUDIT_RESOURCE_TYPE,
    resourceId: input.resourceId,
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
    // eslint-disable-next-line no-console -- terminal failure path (same rationale as rag-audit)
    console.error('[agent-audit] failed to append audit entry', error);
  });
}
