import type { Request, RequestHandler, Response } from 'express';
import { Types } from 'mongoose';

import { AppError } from '../../core/errors/app-error.js';

import { findWorkspaceById } from './workspace.repository.js';
import { getMembership, isWorkspaceOwner } from './workspace.service.js';
import type { WorkspaceDocument, WorkspaceMemberDocument } from './workspace.types.js';
import { workspaceIdParamSchema } from './workspace.validation.js';

/**
 * Workspace-context middleware — the composable gate for every route that
 * operates inside a workspace. Composes AFTER `requireAuth` (reads `req.auth`)
 * and NEVER replaces it: routes needing a workspace attach both middlewares,
 * and auth routes stay workspace-free (sequential composition, no global
 * workspace requirement).
 *
 * Pipeline (each failure short-circuits with the documented status):
 *   1. `req.auth` present (requireAuth ran) — else 401.
 *   2. `:workspaceId` param parses as an ObjectId — else 404 (unknown
 *      workspace shape; never 500 on malformed input).
 *   3. Workspace exists AND status is `active` — else 404 (archived
 *      workspaces are indistinguishable from missing ones: no existence
 *      oracle, no leak of other tenants).
 *   4. Membership exists AND status is `active` — else 404 (invited /
 *      suspended members get the same response as strangers).
 *   5. `req.workspace` context attached, typed by module augmentation.
 *
 * Never trusts a client-supplied workspace id: access is granted only through
 * the membership row loaded from the database on every request.
 */

/** Strongly typed request context attached by `requireWorkspaceContext`. */
export interface WorkspaceContext {
  readonly workspaceId: string;
  readonly workspace: WorkspaceDocument;
  /** The caller's (verified-active) membership row. */
  readonly membership: WorkspaceMemberDocument;
  /** Convenience for owner-only routes; Prompt 6 widens this into RBAC. */
  readonly isOwner: boolean;
  readonly role: WorkspaceMemberDocument['role'];
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Present only after `requireWorkspaceContext` succeeded. */
    workspace?: WorkspaceContext;
  }
}

export function requireWorkspaceContext(): RequestHandler {
  return async (req: Request, _res: Response, next: (error?: unknown) => void): Promise<void> => {
    const auth = req.auth;
    if (auth === undefined) {
      next(AppError.unauthorized());
      return;
    }

    const validatedParams = (req as Request & { validated?: { params?: unknown } }).validated
      ?.params as Record<string, string> | undefined;
    // Defense-in-depth: re-check the FULL params object against the param
    // schema (same object shape the validate middleware already enforced at
    // the route layer — see workspace.validation.ts).
    const paramParse = workspaceIdParamSchema.safeParse(
      validatedParams ?? req.params,
    );
    if (!paramParse.success) {
      next(AppError.notFound('Workspace not found'));
      return;
    }
    const workspaceId = paramParse.data['workspaceId'];

    const workspace = await findWorkspaceById(new Types.ObjectId(workspaceId));
    if (workspace === null || workspace.status !== 'active') {
      next(AppError.notFound('Workspace not found'));
      return;
    }

    const membership = await getMembership(workspaceId, auth.userId);
    if (membership === null || membership.status !== 'active') {
      next(AppError.notFound('Workspace not found'));
      return;
    }

    req.workspace = {
      workspaceId,
      workspace,
      membership,
      isOwner: isWorkspaceOwner(workspace, auth.userId),
      role: membership.role,
    };
    next();
  };
}
