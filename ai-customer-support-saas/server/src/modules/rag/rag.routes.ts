import { Router } from 'express';

import { createRateLimiter } from '../../core/middlewares/rate-limiter.middleware.js';
import { validate } from '../../core/middlewares/validate.middleware.js';
import { requireAuth } from '../auth/require-auth.middleware.js';
import { WORKSPACE_PERMISSIONS } from '../rbac/rbac.permissions.js';
import { requirePermission } from '../rbac/require-permission.middleware.js';
import { requireWorkspaceContext } from '../workspaces/require-workspace.middleware.js';

import {
  indexArticleController,
  indexDocumentController,
  listChunksController,
  purgeSourceController,
  ragStatusController,
} from './rag.controller.js';
import {
  ragArticleParamsSchema,
  ragChunksQuerySchema,
  ragPurgeParamsSchema,
  ragSourceParamsSchema,
} from './rag.validation.js';

/**
 * RAG management routes (Prompt 13) — mounted at
 * `/api/v1/workspaces/:workspaceId/rag`.
 *
 * Gate order per route (identical to every other module):
 *
 *   1. requireAuth                      → 401
 *   2. validate(schema, source)         → 422
 *   3. requireWorkspaceContext()        → 404 (foreign/inactive concealed)
 *   4. requirePermission(...)           → 403 (registry decision + audit)
 *
 * Permission mapping (centralized registry — no competing grants):
 * - `rag.view` (owner/admin): read indexing status and the chunk inventory.
 * Deliberately NOT granted to agent/viewer: AI-pipeline internals are
 * administration, not desk work or read-only business records.
 * - `rag.index` (owner/admin): trigger indexing/reindexing, purge chunks.
 *
 * Indexing calls a paid, memory-expensive provider path: a dedicated 30/min/IP
 * limiter protects it (same technique as the document upload limiter).
 */

const indexLimiter = createRateLimiter({ windowMs: 60_000, limit: 30 });

const requireRagView = requirePermission(WORKSPACE_PERMISSIONS.viewRag);
const requireRagIndex = requirePermission(WORKSPACE_PERMISSIONS.indexRag);
const requireWorkspace = requireWorkspaceContext();

export const ragRouter = Router({ mergeParams: true });

ragRouter.get(
  '/status',
  requireAuth,
  requireWorkspace,
  requireRagView,
  ragStatusController,
);

ragRouter.get(
  '/chunks',
  requireAuth,
  validate(ragChunksQuerySchema, 'query'),
  requireWorkspace,
  requireRagView,
  listChunksController,
);

ragRouter.post(
  '/documents/:fileId/index',
  requireAuth,
  indexLimiter,
  validate(ragSourceParamsSchema, 'params'),
  requireWorkspace,
  requireRagIndex,
  indexDocumentController,
);

ragRouter.post(
  '/articles/:articleId/index',
  requireAuth,
  indexLimiter,
  validate(ragArticleParamsSchema, 'params'),
  requireWorkspace,
  requireRagIndex,
  indexArticleController,
);

ragRouter.delete(
  '/sources/:sourceType/:sourceId',
  requireAuth,
  validate(ragPurgeParamsSchema, 'params'),
  requireWorkspace,
  requireRagIndex,
  purgeSourceController,
);
