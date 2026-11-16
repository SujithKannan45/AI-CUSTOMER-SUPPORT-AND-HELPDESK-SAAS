import type { Request, RequestHandler } from 'express';

import { asyncHandler, sendSuccess } from '../../core/http/api-response.js';
import { resolveEffectiveRole } from '../rbac/require-permission.middleware.js';

import { searchWorkspaceFlow, type SearchRequestContext } from './search.service.js';
import type { WorkspaceSearchQuery } from './search.validation.js';

/**
 * Unified search controller — HTTP shape only (validated input → service →
 * envelope). Auth, workspace context and RBAC-aware fan-out already ran:
 *
 *   requireAuth → validate(params) → requireWorkspaceContext() → limiter
 *   → validate(query) → service (per-entity permission checks)
 *
 * No client value here can name a workspace, an actor or a field.
 */

interface SearchValidatedRequest extends Request {
  readonly validated?: { readonly params?: { readonly workspaceId: string } };
}

function contextOf(req: SearchValidatedRequest): SearchRequestContext {
  const workspace = req.workspace!;
  return {
    workspaceId: workspace.workspaceId,
    actorId: req.auth!.userId,
    role: resolveEffectiveRole(workspace),
  };
}

/** GET …/search?q=… — bounded, permission-filtered workspace search preview. */
export const searchWorkspaceController: RequestHandler = asyncHandler(async (req, res) => {
  const payload = await searchWorkspaceFlow(
    contextOf(req as SearchValidatedRequest),
    req.query as unknown as WorkspaceSearchQuery,
  );
  sendSuccess(res, 200, payload, req);
});
