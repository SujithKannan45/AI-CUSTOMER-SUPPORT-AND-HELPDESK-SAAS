import type { Request } from 'express';
import type { Types } from 'mongoose';

import { AuditLogModel } from '../audit-logs/audit-log.model.js';

/**
 * Audit helper for authorization events — composes on the EXISTING AuditLog
 * collection (same fire-and-forget pattern as auth-audit / workspace-audit:
 * a failed audit append never breaks the user-visible flow).
 *
 * Actions (dotted taxonomy, matching the model's `<domain>.<verb>` pattern):
 * - `workspace.permission_denied` — an authenticated, active member attempted
 *   a privileged operation their role does not grant. Only rejects of
 *   permission-guarded operations land here (regular 404-concealment for
 *   strangers/inactive members is NOT logged — it would enumerate and flood),
 *   which keeps volume bounded by real access attempts.
 * - `member.role_changed` — reserved for the future membership endpoints;
 *   the policy layer exports it so those flows cannot forget the audit hook.
 * - `workspace.security_changed` — reserved for future security-setting
 *   endpoints (owner-only per the permission registry).
 *
 * NEVER recorded: secrets, tokens, credentials, request headers beyond
 * coarse ip/user-agent — only ids, role names, and permission identifiers.
 */

/** Reserved audit action names for the RBAC domain (open vocabulary by design). */
export const RBAC_AUDIT_ACTIONS = {
  permissionDenied: 'workspace.permission_denied',
  roleChanged: 'member.role_changed',
  securityChanged: 'workspace.security_changed',
} as const;

export interface RbacAuditInput {
  readonly action: (typeof RBAC_AUDIT_ACTIONS)[keyof typeof RBAC_AUDIT_ACTIONS];
  readonly workspaceId: Types.ObjectId;
  readonly actorId: Types.ObjectId;
  readonly resourceId?: string;
  readonly metadata?: Record<string, unknown>;
  readonly request?: Request;
}

export function recordRbacAudit(input: RbacAuditInput): void {
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
    console.error('[rbac-audit] failed to append audit entry', error);
  });
}
