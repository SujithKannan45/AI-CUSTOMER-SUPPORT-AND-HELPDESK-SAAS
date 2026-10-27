import type { Request } from 'express';
import type { Types } from 'mongoose';

import { AuditLogModel } from '../audit-logs/audit-log.model.js';

/**
 * Audit helper for RAG indexing events — composes on the EXISTING AuditLog
 * collection with the same fire-and-forget convention as document-audit:
 * a failed append never breaks the user-visible flow and is logged loudly.
 *
 * Actions (dotted taxonomy): rag.source_indexed / rag.source_purged
 *
 * NEVER recorded: chunk or source TEXT, filenames, embeddings — only ids,
 * counts and statuses (the compliance trail stays content-free).
 */
export const RAG_AUDIT_RESOURCE_TYPE = 'rag_index' as const;

export const RAG_AUDIT_ACTIONS = {
  sourceIndexed: 'rag.source_indexed',
  sourcePurged: 'rag.source_purged',
} as const;

export type RagAuditAction = (typeof RAG_AUDIT_ACTIONS)[keyof typeof RAG_AUDIT_ACTIONS];

export interface RagAuditInput {
  readonly action: RagAuditAction;
  readonly workspaceId: Types.ObjectId;
  readonly actorId: Types.ObjectId;
  readonly resourceId: string;
  /** Structured context (source type/ids, chunk counts) — no content. */
  readonly metadata?: Record<string, unknown>;
  readonly request?: Request;
}

export function recordRagAudit(input: RagAuditInput): void {
  void AuditLogModel.create({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: input.action,
    resourceType: RAG_AUDIT_RESOURCE_TYPE,
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
    // eslint-disable-next-line no-console -- terminal failure path (same rationale as document-audit)
    console.error('[rag-audit] failed to append audit entry', error);
  });
}
