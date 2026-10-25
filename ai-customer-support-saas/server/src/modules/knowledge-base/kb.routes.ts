import { Router } from 'express';

import { validate } from '../../core/middlewares/validate.middleware.js';
import { requireAuth } from '../auth/require-auth.middleware.js';
import { WORKSPACE_PERMISSIONS } from '../rbac/rbac.permissions.js';
import { requirePermission } from '../rbac/require-permission.middleware.js';
import { requireWorkspaceContext } from '../workspaces/require-workspace.middleware.js';

import {
  archiveArticleController,
  createArticleController,
  getArticleController,
  getRevisionController,
  listArticlesController,
  listRevisionsController,
  publishArticleController,
  restoreArticleController,
  restoreRevisionController,
  unpublishArticleController,
  updateArticleController,
} from './kb-article.controller.js';
import {
  archiveCategoryController,
  createCategoryController,
  getCategoryController,
  listCategoriesController,
  restoreCategoryController,
  updateCategoryController,
} from './kb-category.controller.js';
import {
  createArticleSchema,
  createCategorySchema,
  kbArticleParamSchema,
  kbCategoryParamSchema,
  kbLifecycleSchema,
  kbRevisionParamSchema,
  listArticlesQuerySchema,
  listCategoriesQuerySchema,
  listRevisionsQuerySchema,
  updateArticleSchema,
  updateCategorySchema,
} from './kb.validation.js';

/**
 * Knowledge Base routes — mounted at TWO prefixes in routes/api.routes.ts:
 *
 *   /api/v1/workspaces/:workspaceId/knowledge-base/…   (authenticated staff)
 *   /api/v1/public/knowledge-base/:workspaceSlug/…     (anonymous, see
 *                                                       kb-public.routes.ts)
 *
 * `mergeParams` carries the parent `:workspaceId`. Gate order per route
 * (identical to the tickets/customers/conversations modules):
 *
 *   1. requireAuth                             → 401
 *   2. validate(schema, 'params'|'body'|'query') → 422
 *   3. requireWorkspaceContext()               → 404 (foreign/inactive concealed)
 *   4. requirePermission(...)                  → 403 (registry decision + audit)
 *
 * Permission mapping (centralized registry — no competing grants):
 * - `kb.view` (owner/admin/agent/viewer) — READ everything KB: categories,
 *   articles, revision history. Added to the registry by this module; every
 *   workspace member is allowed to read.
 * - `kb.manage` (owner/admin) — ALL mutations: category/article creation and
 *   editing, publish/unpublish, archive/restore, revision restore. Agents
 *   are deliberately NOT granted KB authoring (the registry documents the
 *   rationale); extending grants is a one-entry registry edit, not new code.
 */

const requireWorkspace = requireWorkspaceContext();
const requireKbView = requirePermission(WORKSPACE_PERMISSIONS.viewKnowledgeBase);
const requireKbManage = requirePermission(WORKSPACE_PERMISSIONS.manageKnowledgeBase);

export const knowledgeBaseRouter = Router({ mergeParams: true });

// ── Categories ───────────────────────────────────────────────────────────────

knowledgeBaseRouter.post(
  '/categories',
  requireAuth,
  validate(createCategorySchema),
  requireWorkspace,
  requireKbManage,
  createCategoryController,
);

knowledgeBaseRouter.get(
  '/categories',
  requireAuth,
  validate(listCategoriesQuerySchema, 'query'),
  requireWorkspace,
  requireKbView,
  listCategoriesController,
);

knowledgeBaseRouter.get(
  '/categories/:categoryId',
  requireAuth,
  validate(kbCategoryParamSchema, 'params'),
  requireWorkspace,
  requireKbView,
  getCategoryController,
);

knowledgeBaseRouter.patch(
  '/categories/:categoryId',
  requireAuth,
  validate(kbCategoryParamSchema, 'params'),
  validate(updateCategorySchema),
  requireWorkspace,
  requireKbManage,
  updateCategoryController,
);

knowledgeBaseRouter.post(
  '/categories/:categoryId/archive',
  requireAuth,
  validate(kbCategoryParamSchema, 'params'),
  validate(kbLifecycleSchema),
  requireWorkspace,
  requireKbManage,
  archiveCategoryController,
);

knowledgeBaseRouter.post(
  '/categories/:categoryId/restore',
  requireAuth,
  validate(kbCategoryParamSchema, 'params'),
  validate(kbLifecycleSchema),
  requireWorkspace,
  requireKbManage,
  restoreCategoryController,
);

// ── Articles ─────────────────────────────────────────────────────────────────

knowledgeBaseRouter.post(
  '/articles',
  requireAuth,
  validate(createArticleSchema),
  requireWorkspace,
  requireKbManage,
  createArticleController,
);

knowledgeBaseRouter.get(
  '/articles',
  requireAuth,
  validate(listArticlesQuerySchema, 'query'),
  requireWorkspace,
  requireKbView,
  listArticlesController,
);

knowledgeBaseRouter.get(
  '/articles/:articleId',
  requireAuth,
  validate(kbArticleParamSchema, 'params'),
  requireWorkspace,
  requireKbView,
  getArticleController,
);

knowledgeBaseRouter.patch(
  '/articles/:articleId',
  requireAuth,
  validate(kbArticleParamSchema, 'params'),
  validate(updateArticleSchema),
  requireWorkspace,
  requireKbManage,
  updateArticleController,
);

knowledgeBaseRouter.post(
  '/articles/:articleId/publish',
  requireAuth,
  validate(kbArticleParamSchema, 'params'),
  validate(kbLifecycleSchema),
  requireWorkspace,
  requireKbManage,
  publishArticleController,
);

knowledgeBaseRouter.post(
  '/articles/:articleId/unpublish',
  requireAuth,
  validate(kbArticleParamSchema, 'params'),
  validate(kbLifecycleSchema),
  requireWorkspace,
  requireKbManage,
  unpublishArticleController,
);

knowledgeBaseRouter.post(
  '/articles/:articleId/archive',
  requireAuth,
  validate(kbArticleParamSchema, 'params'),
  validate(kbLifecycleSchema),
  requireWorkspace,
  requireKbManage,
  archiveArticleController,
);

knowledgeBaseRouter.post(
  '/articles/:articleId/restore',
  requireAuth,
  validate(kbArticleParamSchema, 'params'),
  validate(kbLifecycleSchema),
  requireWorkspace,
  requireKbManage,
  restoreArticleController,
);

// ── Revisions (history is readable, restorable — never writable directly) ───

knowledgeBaseRouter.get(
  '/articles/:articleId/revisions',
  requireAuth,
  validate(kbArticleParamSchema, 'params'),
  validate(listRevisionsQuerySchema, 'query'),
  requireWorkspace,
  requireKbView,
  listRevisionsController,
);

knowledgeBaseRouter.get(
  '/articles/:articleId/revisions/:revisionNumber',
  requireAuth,
  validate(kbRevisionParamSchema, 'params'),
  requireWorkspace,
  requireKbView,
  getRevisionController,
);

knowledgeBaseRouter.post(
  '/articles/:articleId/revisions/:revisionNumber/restore',
  requireAuth,
  validate(kbRevisionParamSchema, 'params'),
  validate(kbLifecycleSchema),
  requireWorkspace,
  requireKbManage,
  restoreRevisionController,
);
