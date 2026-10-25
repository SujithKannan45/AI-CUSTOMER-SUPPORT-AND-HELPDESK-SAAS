import type { Request } from 'express';
import type { Types } from 'mongoose';

import { AuditLogModel } from '../audit-logs/audit-log.model.js';

/**
 * Audit helper for knowledge-base events — composes on the EXISTING AuditLog
 * collection (same fire-and-forget pattern as auth-audit / ticket-audit /
 * conversation-audit: a failed audit append never breaks the user-visible
 * flow, and the failure is logged loudly for operations).
 *
 * Actions recorded by the KB module (dotted taxonomy):
 *   kb.category.created / kb.category.updated / kb.category.archived /
 *   kb.category.restored
 *   kb.article.created / kb.article.updated / kb.article.published /
 *   kb.article.unpublished / kb.article.archived / kb.article.restored /
 *   kb.article.revision_restored
 *
 * NEVER recorded: article bodies, summaries, category descriptions or any
 * content — lifecycle changes are audited with field NAMES, ids, slugs and
 * revision numbers only, mirroring the ticket module's no-content rule.
 *
 * Anonymous public KB reads are deliberately NOT audited: they are
 * unauthenticated traffic (flooding the compliance trail would be the abuse
 * vector, not the protection). Documented public-read behavior.
 */
export const KB_RESOURCE_TYPES = {
  category: 'kb_category',
  article: 'kb_article',
  revision: 'kb_article_revision',
} as const;

export const KB_AUDIT_ACTIONS = {
  categoryCreated: 'kb.category.created',
  categoryUpdated: 'kb.category.updated',
  categoryArchived: 'kb.category.archived',
  categoryRestored: 'kb.category.restored',
  articleCreated: 'kb.article.created',
  articleUpdated: 'kb.article.updated',
  articlePublished: 'kb.article.published',
  articleUnpublished: 'kb.article.unpublished',
  articleArchived: 'kb.article.archived',
  articleRestored: 'kb.article.restored',
  revisionRestored: 'kb.article.revision_restored',
} as const;

export type KbAuditAction = (typeof KB_AUDIT_ACTIONS)[keyof typeof KB_AUDIT_ACTIONS];
export type KbAuditResourceType =
  (typeof KB_RESOURCE_TYPES)[keyof typeof KB_RESOURCE_TYPES];

export interface KbAuditInput {
  readonly action: KbAuditAction;
  readonly workspaceId: Types.ObjectId;
  readonly actorId: Types.ObjectId;
  readonly resourceType: KbAuditResourceType;
  readonly resourceId: string;
  /** Structured context (slugs, ids, field names, revision numbers) — no content. */
  readonly metadata?: Record<string, unknown>;
  readonly request?: Request;
}

export function recordKbAudit(input: KbAuditInput): void {
  void AuditLogModel.create({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: input.action,
    resourceType: input.resourceType,
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
    // eslint-disable-next-line no-console -- terminal failure path (same rationale as ticket-audit)
    console.error('[kb-audit] failed to append audit entry', error);
  });
}
