import { Router } from 'express';

import { validate } from '../../core/middlewares/validate.middleware.js';
import { requireAuth } from '../auth/require-auth.middleware.js';

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
 *   1. `requireAuth` — identity.
 *   2. `validate(schema, 'params'|'body'|'query')` — typed, parsed inputs.
 *   3. `requireWorkspaceContext()` — tenant + membership (detail/patch only).
 *
 * Invite / member-management endpoints are intentionally absent (Prompt 5
 * scope); they extend this router in a later phase with their own limiter.
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
  getWorkspaceController,
);

workspaceRouter.patch(
  '/:workspaceId',
  requireAuth,
  validate(workspaceIdParamSchema, 'params'),
  validate(updateWorkspaceSchema),
  requireWorkspace,
  updateWorkspaceController,
);
