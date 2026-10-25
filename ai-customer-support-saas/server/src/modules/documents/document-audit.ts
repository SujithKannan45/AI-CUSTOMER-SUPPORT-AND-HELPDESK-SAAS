import type { Request } from 'express';
import type { Types } from 'mongoose';

import { AuditLogModel } from '../audit-logs/audit-log.model.js';

/**
 * Audit helper for document events — composes on the EXISTING AuditLog
 * collection with the same fire-and-forget convention as kb-audit /
 * ticket-audit: a failed append never breaks the user-visible flow and is
 * logged loudly.
 *
 * Actions (dotted taxonomy):
 *   document.uploaded / document.reprocessed / document.deleted
 *
 * NEVER recorded: original filenames (user-controlled strings do not belong
 * in the compliance trail), extracted text, checksums are recorded (they are
 * opaque fingerprints useful for forensics) — no content.
 */
export const DOCUMENT_AUDIT_RESOURCE_TYPE = 'file' as const;

export const DOCUMENT_AUDIT_ACTIONS = {
  documentUploaded: 'document.uploaded',
  documentReprocessed: 'document.reprocessed',
  documentDeleted: 'document.deleted',
} as const;

export type DocumentAuditAction = (typeof DOCUMENT_AUDIT_ACTIONS)[keyof typeof DOCUMENT_AUDIT_ACTIONS];

export interface DocumentAuditInput {
  readonly action: DocumentAuditAction;
  readonly workspaceId: Types.ObjectId;
  readonly actorId: Types.ObjectId;
  readonly resourceId: string;
  /** Structured context (ids, sizes, media types) — no content, no filename. */
  readonly metadata?: Record<string, unknown>;
  readonly request?: Request;
}

export function recordDocumentAudit(input: DocumentAuditInput): void {
  void AuditLogModel.create({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: input.action,
    resourceType: DOCUMENT_AUDIT_RESOURCE_TYPE,
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
    // eslint-disable-next-line no-console -- terminal failure path (same rationale as kb-audit)
    console.error('[document-audit] failed to append audit entry', error);
  });
}
