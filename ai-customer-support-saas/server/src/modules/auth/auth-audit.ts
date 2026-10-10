import type { Request } from 'express';
import { Types } from 'mongoose';

import { AuditLogModel } from '../audit-logs/audit-log.model.js';

/**
 * Audit helper for authentication events.
 *
 * The AuditLog model requires a `workspaceId` (it was designed for
 * tenant-scoped events), but authentication happens BEFORE any workspace
 * context exists. Auth events therefore use the reserved ALL-ZERO ObjectId
 * as a platform-level scope sentinel:
 *
 *   PLATFORM_SCOPE (000000000000000000000000)
 *
 * It can never collide with a real workspace id and gives auth events a
 * stable, queryable scope. When the workspace phase introduces per-workspace
 * user-management events, those will pass real workspace ids instead.
 *
 * Actions recorded (dotted `<domain>.<verb>`, per the audit taxonomy):
 *   user.login, user.login_failed, user.logout, user.logout_all,
 *   user.registered, user.email_verified, user.password_reset,
 *   user.password_reset_requested, user.refresh_token_reuse_detected
 *
 * NEVER recorded: passwords, access/refresh/verification/reset tokens,
 * authorization or cookie headers. Only ids, emails, IPs, user agents and
 * coarse metadata are persisted.
 */

/** Reserved all-zero workspace scope for platform-level (pre-workspace) events. */
export const PLATFORM_SCOPE = new Types.ObjectId('000000000000000000000000');

export interface AuthAuditInput {
  readonly action: string;
  readonly actorId?: Types.ObjectId | null;
  readonly email?: string;
  readonly request?: Request;
  readonly metadata?: Record<string, unknown>;
}

/** Fire-and-forget audit write — audit failures never break the auth flow. */
export function recordAuthAudit(input: AuthAuditInput): void {
  void AuditLogModel.create({
    workspaceId: PLATFORM_SCOPE,
    ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
    action: input.action,
    resourceType: 'user',
    ...(input.email !== undefined ? { resourceId: input.email } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    ...(input.request !== undefined
      ? {
          ip: firstForwardedIp(input.request) ?? input.request.ip,
          userAgent: input.request.headers['user-agent']?.slice(0, 512),
        }
      : {}),
  }).catch((error: unknown) => {
    // Swallow + log: a failed audit append must not fail a login/logout that
    // has already succeeded (or a failed login that must stay anti-enumerable).
    // eslint-disable-next-line no-console -- logger import would create a cycle; this is a terminal failure path
    console.error('[auth-audit] failed to append audit entry', error);
  });
}

/** Returns the first hop of X-Forwarded-For when present (trust proxy = 1). */
function firstForwardedIp(request: Request): string | undefined {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]?.trim();
  }
  return undefined;
}
