import type { Request, RequestHandler } from 'express';
import { Types } from 'mongoose';

import { asyncHandler, sendSuccess } from '../../core/http/api-response.js';

import type { WorkspaceContext } from './require-workspace.middleware.js';
import { recordWorkspaceAudit } from './workspace-audit.js';
import { toWorkspaceDto, toWorkspaceMembershipDto } from './workspace.dto.js';
import {
  createWorkspaceFlow,
  listWorkspacesFlow,
  updateWorkspaceFlow,
} from './workspace.service.js';
import type {
  CreateWorkspaceInput,
  ListWorkspacesQuery,
  UpdateWorkspaceInput,
} from './workspace.validation.js';

/**
 * Workspace controllers — HTTP shape only: parse → service → respond.
 * All authorization decisions live in the service/middleware layers.
 */

/**
 * POST /api/v1/workspaces — create a workspace; the AUTHENTICATED user is the
 * owner (client-supplied owner ids are impossible here because the owner id
 * is never read from the request body at all).
 */
export const createWorkspaceController: RequestHandler = asyncHandler(async (req, res) => {
  const auth = req.auth!;
  const input = req.body as CreateWorkspaceInput;
  const payload = await createWorkspaceFlow(input, auth.userId, {
    ...(req.ip !== undefined ? { ip: req.ip } : {}),
    ...(typeof req.headers['user-agent'] === 'string'
      ? { userAgent: req.headers['user-agent'] }
      : {}),
  });

  recordWorkspaceAudit({
    action: 'workspace.created',
    workspaceId: new Types.ObjectId(payload.workspace.id),
    actorId: new Types.ObjectId(auth.userId),
    resourceId: payload.workspace.id,
    metadata: { slug: payload.workspace.slug, role: payload.membership.role },
    request: req,
  });

  sendSuccess(res, 201, payload, req);
});

/** GET /api/v1/workspaces — active memberships of the authenticated user, paginated. */
export const listWorkspacesController: RequestHandler = asyncHandler(async (req, res) => {
  const auth = req.auth!;
  const query = req.query as unknown as ListWorkspacesQuery;
  const payload = await listWorkspacesFlow({
    userId: auth.userId,
    page: query.page,
    limit: query.limit,
  });
  sendSuccess(res, 200, payload, req);
});

/**
 * GET /api/v1/workspaces/:workspaceId — detail for an ACTIVE member.
 * The workspace-context middleware guarantees an active membership; the
 * controller reads `req.workspace` without SQL/DB calls of its own.
 */
export const getWorkspaceController: RequestHandler = (
  req: Request & { workspace?: WorkspaceContext },
  res,
) => {
  const context = req.workspace!;
  sendSuccess(
    res,
    200,
    {
      workspace: toWorkspaceDto(context.workspace),
      membership: toWorkspaceMembershipDto(context.membership),
    },
    req,
  );
};

/** PATCH /api/v1/workspaces/:workspaceId — owner-only edits of approved fields. */
export const updateWorkspaceController: RequestHandler = asyncHandler(async (req, res) => {
  const auth = req.auth!;
  const context = req.workspace!;
  const updates = req.body as UpdateWorkspaceInput;
  const workspace = await updateWorkspaceFlow(
    context.workspaceId,
    auth.userId,
    updates,
  );

  recordWorkspaceAudit({
    action: 'workspace.updated',
    workspaceId: new Types.ObjectId(workspace.id),
    actorId: new Types.ObjectId(auth.userId),
    resourceId: workspace.id,
    // Only FIELD NAMES are audited — never field values, which may contain
    // user content in later phases.
    metadata: {
      fields: [
        ...(updates.name !== undefined ? ['name'] : []),
        ...(updates.settings !== undefined ? ['settings'] : []),
      ],
    },
    request: req,
  });

  sendSuccess(res, 200, { workspace }, req);
});
