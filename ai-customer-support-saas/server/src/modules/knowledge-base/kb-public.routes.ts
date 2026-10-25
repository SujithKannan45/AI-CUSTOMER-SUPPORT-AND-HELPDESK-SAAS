import { Router } from 'express';

import { createRateLimiter } from '../../core/middlewares/rate-limiter.middleware.js';
import { validate } from '../../core/middlewares/validate.middleware.js';

import {
  publicGetArticleController,
  publicListArticlesController,
  publicListCategoriesController,
} from './kb-public.controller.js';
import {
  kbPaginationSchema,
  publicArticleParamSchema,
  publicListArticlesQuerySchema,
  publicWorkspaceParamSchema,
} from './kb.validation.js';

/**
 * PUBLIC Knowledge Base routes — mounted at `/api/v1/public/knowledge-base`:
 *
 *   GET /:workspaceSlug/categories          — live categories (public DTO)
 *   GET /:workspaceSlug/articles            — PUBLISHED only, paginated
 *   GET /:workspaceSlug/articles/:articleSlug — one published article
 *
 * NO requireAuth, NO workspace-context middleware, NO permission gate: the
 * safety properties come from the public service — the workspace slug is
 * validated against the workspaces repository (404 otherwise) and the
 * published-only filter is composed server-side and is NOT a client field.
 *
 * Anonymous traffic gets a dedicated, tighter rate limiter than the global
 * API backstop (env-configured window, fixed per-window budget): the same
 * `createRateLimiter` factory that auth will use for sensitive endpoints.
 */
const publicKbLimiter = createRateLimiter({
  windowMs: 60_000,
  limit: 120,
});

export const publicKnowledgeBaseRouter = Router({ mergeParams: true });

publicKnowledgeBaseRouter.use(publicKbLimiter);

publicKnowledgeBaseRouter.get(
  '/:workspaceSlug/categories',
  validate(publicWorkspaceParamSchema, 'params'),
  validate(kbPaginationSchema, 'query'),
  publicListCategoriesController,
);

publicKnowledgeBaseRouter.get(
  '/:workspaceSlug/articles',
  validate(publicWorkspaceParamSchema, 'params'),
  validate(publicListArticlesQuerySchema, 'query'),
  publicListArticlesController,
);

publicKnowledgeBaseRouter.get(
  '/:workspaceSlug/articles/:articleSlug',
  validate(publicArticleParamSchema, 'params'),
  publicGetArticleController,
);
