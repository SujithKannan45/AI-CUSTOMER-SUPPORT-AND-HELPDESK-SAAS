import type { Request } from 'express';
import type { Types } from 'mongoose';

import { AuditLogModel } from '../audit-logs/audit-log.model.js';

/**
 * Audit helper for workspace events — composes on the EXISTING AuditLog
 * collection (no separate subsystem) and reuses the fire-and-forget pattern
 * from the auth module: a failed audit append never breaks the user-visible
 * flow.
 *
 * Actions recorded in this phase (dotted taxonomy, `workspace.<verb>`):
 *   workspace.created, workspace.updated, workspace.member_registered
 * (the membership row that documents the creator's owner role).
 *
 * NEVER recorded: secrets, tokens, credentials of any kind — only ids,
 * slugs, role names and coarse metadata.
 */

export interface WorkspaceAuditInput {
  readonly action: string;
  readonly workspaceId: Types.ObjectId;
  readonly actorId: Types.ObjectId;
  readonly resourceId?: string;
  readonly metadata?: Record<string, unknown>;
  readonly request?: Request;
}

export function recordWorkspaceAudit(input: WorkspaceAuditInput): void {
  void AuditLogModel.create({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: input.action,
    resourceType: 'workspace',
    ...(input.resourceId !== undefined ? { resourceId: input.resourceId } : {}),
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
    console.error('[workspace-audit] failed to append audit entry', error);
  });
}
