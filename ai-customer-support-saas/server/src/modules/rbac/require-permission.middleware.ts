import type { Request, RequestHandler, Response } from 'express';
import { Types } from 'mongoose';

import { AppError } from '../../core/errors/app-error.js';
import { logger } from '../../core/logger/logger.js';
import type { WorkspaceContext } from '../workspaces/require-workspace.middleware.js';
import {
  hasAtLeastRole,
  type WorkspaceRole,
} from '../workspaces/workspace.types.js';

import { recordRbacAudit, RBAC_AUDIT_ACTIONS } from './rbac-audit.js';
import { roleHasPermission, type WorkspacePermission } from './rbac.permissions.js';

/**
 * Authorization middleware — composes AFTER `requireAuth` and
 * `requireWorkspaceContext()`:
 *
 *   requireAuth                     → req.auth        (identity, 401 on fail)
 *   validate(schema, 'params')      → workspace id well-formed
 *   requireWorkspaceContext()       → req.workspace   (tenant + membership)
 *   requirePermission(permission)   → 403 unless the membership's role grants
 *
 * The effective role is derived ONLY from the server-validated membership
 * row attached by the workspace middleware — never from body, query,
 * headers or any client-supplied field. Because `requireWorkspaceContext`
 * already rejects inactive/invited/suspended memberships with 404
 * concealment, a role granted here implies an ACTIVE membership.
 */

/**
 * Effective role for authorization decisions.
 *
 * Normally `membership.role`. Defense-in-depth: if the workspace's `ownerId`
 * points at the member but their membership row no longer says `owner` (an
 * integrity anomaly the single-owner partial index cannot fully prevent for
 * the role FIELD), the owner is treated as owner so a corrupted row can
 * never lock a tenant out of its own workspace. The anomaly is logged — it
 * is not a normal path, and surfaced for investigation, not hidden.
 */
export function resolveEffectiveRole(context: WorkspaceContext): WorkspaceRole {
  const role = context.membership.role;
  const membershipUserId = context.membership.userId;
  if (
    role !== 'owner' &&
    context.workspace.ownerId.toHexString() === membershipUserId.toHexString()
  ) {
    logger.warn(
      { workspaceId: context.workspaceId },
      'RBAC integrity anomaly: ownerId user holds a non-owner membership role; treating as owner',
    );
    return 'owner';
  }
  return role;
}

/** Typed, string-safe ObjectId coercion for audit writes. */
function toObjectId(value: Types.ObjectId | string): Types.ObjectId {
  return value instanceof Types.ObjectId ? value : new Types.ObjectId(value);
}

/**
 * Permission gate factory — `requirePermission(WORKSPACE_PERMISSIONS.viewWorkspace)`.
 *
 * Failure paths:
 * - Missing `req.auth` → 401 (mis-ordered-middleware defense; requireAuth
 *   should already have run).
 * - Missing `req.workspace` → non-operational 500: this is a ROUTE
 *   DEFINITION bug (permission middleware without the context middleware),
 *   not something a client can cause, so it is logged at error level.
 * - Role lacks the permission → 403 + a `workspace.permission_denied` audit
 *   entry (bounded volume: only permission-guarded operations are audited;
 *   404 concealment for strangers/inactive members is not — that would
 *   enumerate tenants and flood the audit trail).
 */
export function requirePermission(permission: WorkspacePermission): RequestHandler {
  return (req: Request, _res: Response, next: (error?: unknown) => void): void => {
    if (req.auth === undefined) {
      next(AppError.unauthorized());
      return;
    }
    const context = req.workspace;
    if (context === undefined) {
      logger.error(
        { permission },
        'requirePermission ran without workspace context — check middleware order (requireWorkspaceContext must run first)',
      );
      next(
        new AppError('Internal authorization error', {
          statusCode: 500,
          code: 'INTERNAL_ERROR',
          isOperational: false,
        }),
      );
      return;
    }

    const role = resolveEffectiveRole(context);
    if (!roleHasPermission(role, permission)) {
      recordRbacAudit({
        action: RBAC_AUDIT_ACTIONS.permissionDenied,
        workspaceId: new Types.ObjectId(context.workspaceId),
        actorId: toObjectId(context.membership.userId),
        metadata: { requiredPermission: permission, effectiveRole: role },
        request: req,
      });
      next(AppError.forbidden());
      return;
    }
    next();
  };
}

/**
 * Role gate factory — `requireRole('owner')` for the few checks that are
 * about an exact role rather than a specific permission (e.g. a future
 * ownership-transfer endpoint must be owner-exact). Empty role lists throw
 * at registration time: a programming error, not a runtime condition.
 * Denied requests are audited like permission denials.
 */
export function requireRole(...allowed: readonly WorkspaceRole[]): RequestHandler {
  if (allowed.length === 0) {
    throw new AppError('requireRole requires at least one role', {
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      isOperational: false,
    });
  }
  return (req: Request, _res: Response, next: (error?: unknown) => void): void => {
    if (req.auth === undefined) {
      next(AppError.unauthorized());
      return;
    }
    const context = req.workspace;
    if (context === undefined) {
      logger.error(
        { allowed },
        'requireRole ran without workspace context — check middleware order',
      );
      next(
        new AppError('Internal authorization error', {
          statusCode: 500,
          code: 'INTERNAL_ERROR',
          isOperational: false,
        }),
      );
      return;
    }

    const role = resolveEffectiveRole(context);
    if (!allowed.some((candidate) => role === candidate)) {
      recordRbacAudit({
        action: RBAC_AUDIT_ACTIONS.permissionDenied,
        workspaceId: new Types.ObjectId(context.workspaceId),
        actorId: toObjectId(context.membership.userId),
        metadata: { requiredRoles: [...allowed], effectiveRole: role },
        request: req,
      });
      next(AppError.forbidden());
      return;
    }
    next();
  };
}

/**
 * Level-based gate for hierarchy checks ("at least admin"): reuses the
 * existing `hasAtLeastRole` weight comparison for routes where a minimum
 * LEVEL is the natural rule. Used sparingly — prefer permissions.
 */
export function requireRoleLevel(minimum: WorkspaceRole): RequestHandler {
  return (req: Request, _res: Response, next: (error?: unknown) => void): void => {
    if (req.auth === undefined) {
      next(AppError.unauthorized());
      return;
    }
    const context = req.workspace;
    if (context === undefined) {
      logger.error({ minimum }, 'requireRoleLevel ran without workspace context');
      next(
        new AppError('Internal authorization error', {
          statusCode: 500,
          code: 'INTERNAL_ERROR',
          isOperational: false,
        }),
      );
      return;
    }
    if (!hasAtLeastRole(resolveEffectiveRole(context), minimum)) {
      recordRbacAudit({
        action: RBAC_AUDIT_ACTIONS.permissionDenied,
        workspaceId: new Types.ObjectId(context.workspaceId),
        actorId: toObjectId(context.membership.userId),
        metadata: { requiredRoleLevel: minimum, effectiveRole: resolveEffectiveRole(context) },
        request: req,
      });
      next(AppError.forbidden());
      return;
    }
    next();
  };
}
