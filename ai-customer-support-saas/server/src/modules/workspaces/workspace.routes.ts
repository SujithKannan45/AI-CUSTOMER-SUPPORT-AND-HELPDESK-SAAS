import { Router } from 'express';

import { validate } from '../../core/middlewares/validate.middleware.js';
import { requireAuth } from '../auth/require-auth.middleware.js';
import { WORKSPACE_PERMISSIONS } from '../rbac/rbac.permissions.js';
import {
  requirePermission,
} from '../rbac/require-permission.middleware.js';

import { requireWorkspaceContext } from './require-workspace.middleware.js';
import {
  createWorkspaceController,
  listWorkspacesController,
  getWorkspaceController,
  updateWorkspaceController,
} from './workspace.controller.js';
import {
  createWorkspaceSchema,
  listWorkspacesQuerySchema,
  updateWorkspaceSchema,
  workspaceIdParamSchema,
} from './workspace.validation.js';

/**
 * Workspace routes — mounted at `/api/v1/workspaces` (see routes/api.routes.ts).
 *
 * Gate order (deliberate):
 *   1. `requireAuth` — identity (401).
 *   2. `validate(schema, 'params'|'body'|'query')` — typed, parsed inputs.
 *   3. `requireWorkspaceContext()` — tenant + membership (404: suspended,
 *      invited, foreign, unknown, archived — all concealed identically).
 *   4. `requirePermission(...)` — RBAC decision from the DB-derived
 *      membership role (403 + audit entry), per the centralized registry
 *      (modules/rbac/rbac.permissions.ts).
 *
 * Authorization lives in middleware — controllers/services never compare
 * role names. Invite / member-management endpoints are intentionally absent
 * (a later phase extends this router; the service-level policy in
 * modules/rbac/rbac-policy.ts already guards their role rules).
 */
export const workspaceRouter = Router();

const requireWorkspace = requireWorkspaceContext();

workspaceRouter.post(
  '/',
  requireAuth,
  validate(createWorkspaceSchema),
  createWorkspaceController,
);

workspaceRouter.get(
  '/',
  requireAuth,
  validate(listWorkspacesQuerySchema, 'query'),
  listWorkspacesController,
);

workspaceRouter.get(
  '/:workspaceId',
  requireAuth,
  validate(workspaceIdParamSchema, 'params'),
  requireWorkspace,
  requirePermission(WORKSPACE_PERMISSIONS.viewWorkspace),
  getWorkspaceController,
);

workspaceRouter.patch(
  '/:workspaceId',
  requireAuth,
  validate(workspaceIdParamSchema, 'params'),
  validate(updateWorkspaceSchema),
  requireWorkspace,
  // Settings administration: owner + admin per the registry (agents/viewers
  // read-only). The former owner-only service check moved here so
  // authorization is enforced in exactly one layer.
  requirePermission(WORKSPACE_PERMISSIONS.updateWorkspaceSettings),
  updateWorkspaceController,
);
