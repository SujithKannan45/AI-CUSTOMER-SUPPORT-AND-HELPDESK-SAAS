import type { Request, RequestHandler } from 'express';

import { asyncHandler, sendSuccess } from '../../core/http/api-response.js';

import {
  publicGetArticleFlow,
  publicListArticlesFlow,
  publicListCategoriesFlow,
} from './kb-public.service.js';

/**
 * Public KB controllers — the ANONYMOUS read layer (no `requireAuth`!).
 *
 * Deliberately different from the management controllers: there is no actor
 * context, no workspace middleware and no permission gate. Every safety
 * property comes from the service: workspace-slug resolution (404 otherwise)
 * and the hardcoded `{ status: 'PUBLISHED' }` filter. Only explicitly
 * permitted fields are returned (public DTO mappers).
 */

interface PublicKbValidatedRequest extends Request {
  readonly validated?: {
    readonly params?: {
      readonly workspaceSlug?: string;
      readonly articleSlug?: string;
    };
  };
}

function workspaceSlugOf(req: PublicKbValidatedRequest): string {
  return req.validated!.params!.workspaceSlug!;
}

export const publicListCategoriesController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as PublicKbValidatedRequest;
  sendSuccess(
    res,
    200,
    await publicListCategoriesFlow(workspaceSlugOf(r), req.query as unknown as { page: number; limit: number }),
    req,
  );
});

export const publicListArticlesController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as PublicKbValidatedRequest;
  sendSuccess(
    res,
    200,
    await publicListArticlesFlow(workspaceSlugOf(r), req.query as unknown as {
      page: number;
      limit: number;
      categoryId?: string;
      search?: string;
    }),
    req,
  );
});

export const publicGetArticleController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as PublicKbValidatedRequest;
  const articleSlug = r.validated!.params!.articleSlug!;
  sendSuccess(res, 200, await publicGetArticleFlow(workspaceSlugOf(r), articleSlug), req);
});
