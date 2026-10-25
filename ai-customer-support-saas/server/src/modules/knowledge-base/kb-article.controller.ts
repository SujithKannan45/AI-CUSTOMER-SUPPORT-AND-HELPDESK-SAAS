import type { RequestHandler } from 'express';

import { asyncHandler, sendSuccess } from '../../core/http/api-response.js';

import {
  articleLifecycleFlow,
  createArticleFlow,
  getArticleFlow,
  getRevisionFlow,
  listArticlesFlow,
  listRevisionsFlow,
  restoreRevisionFlow,
  updateArticleFlow,
} from './kb-article.service.js';
import { kbContextOf, type KbValidatedRequest } from './kb-category.controller.js';
import type {
  CreateArticleInput,
  ListArticlesQuery,
  UpdateArticleInput,
} from './kb.validation.js';

/**
 * Article controllers — HTTP shape only (parse → service → respond).
 * Authorization has ALREADY happened in middleware; the service enforces the
 * content/revision/lifecycle rules (see kb-article.service.ts).
 */

function articleIdOf(req: KbValidatedRequest): string {
  return req.validated!.params!.articleId!;
}

function revisionNumberOf(req: KbValidatedRequest): number {
  return req.validated!.params!.revisionNumber!;
}

/** POST …/knowledge-base/articles — create a draft with revision 1. */
export const createArticleController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as KbValidatedRequest;
  sendSuccess(res, 201, await createArticleFlow(kbContextOf(r), req.body as CreateArticleInput), req);
});

/** GET …/knowledge-base/articles — filtered/sorted/paginated management listing. */
export const listArticlesController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as KbValidatedRequest;
  sendSuccess(
    res,
    200,
    await listArticlesFlow(kbContextOf(r), req.query as unknown as ListArticlesQuery),
    req,
  );
});

/** GET …/articles/:articleId — full detail (includes the Markdown body). */
export const getArticleController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as KbValidatedRequest;
  sendSuccess(res, 200, await getArticleFlow(kbContextOf(r), articleIdOf(r)), req);
});

/** PATCH …/articles/:articleId — content edit (revision snapshot) + slug rename. */
export const updateArticleController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as KbValidatedRequest;
  sendSuccess(
    res,
    200,
    { article: await updateArticleFlow(kbContextOf(r), articleIdOf(r), req.body as UpdateArticleInput) },
    req,
  );
});

function lifecycleController(action: 'publish' | 'unpublish' | 'archive' | 'restore'): RequestHandler {
  return asyncHandler(async (req, res) => {
    const r = req as KbValidatedRequest;
    sendSuccess(res, 200, { article: await articleLifecycleFlow(kbContextOf(r), articleIdOf(r), action) }, req);
  });
}

export const publishArticleController = lifecycleController('publish');
export const unpublishArticleController = lifecycleController('unpublish');
export const archiveArticleController = lifecycleController('archive');
export const restoreArticleController = lifecycleController('restore');

/** GET …/articles/:articleId/revisions — newest-first history (no snapshot bodies). */
export const listRevisionsController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as KbValidatedRequest;
  sendSuccess(
    res,
    200,
    await listRevisionsFlow(kbContextOf(r), articleIdOf(r), req.query as unknown as { page: number; limit: number }),
    req,
  );
});

/** GET …/articles/:articleId/revisions/:revisionNumber — full snapshot read. */
export const getRevisionController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as KbValidatedRequest;
  sendSuccess(
    res,
    200,
    await getRevisionFlow(kbContextOf(r), articleIdOf(r), revisionNumberOf(r)),
    req,
  );
});

/** POST …/revisions/:revisionNumber/restore — restore old content as a NEW revision. */
export const restoreRevisionController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as KbValidatedRequest;
  sendSuccess(
    res,
    201,
    await restoreRevisionFlow(kbContextOf(r), articleIdOf(r), revisionNumberOf(r)),
    req,
  );
});
