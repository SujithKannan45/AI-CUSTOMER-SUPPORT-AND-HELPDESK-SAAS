import type { Request, RequestHandler } from 'express';

import { asyncHandler, sendSuccess } from '../../core/http/api-response.js';
import { resolveEffectiveRole } from '../rbac/require-permission.middleware.js';

import {
  archiveCategoryFlow,
  createCategoryFlow,
  getCategoryFlow,
  listCategoriesFlow,
  restoreCategoryFlow,
  updateCategoryFlow,
} from './kb-category.service.js';
import type { KbRequestContext } from './kb.dto.js';
import {
  type CreateCategoryInput,
  type UpdateCategoryInput,
} from './kb.validation.js';

/**
 * Category controllers — HTTP shape only (parse → service → respond).
 * Authorization has ALREADY happened in middleware:
 *
 *   requireAuth → validate(...) → requireWorkspaceContext() → requirePermission(...)
 *
 * so handlers read the validated context (`req.workspace`,
 * `req.validated.params`) and the parsed body. Identical composition to
 * conversation.controller.ts.
 */

export interface KbValidatedRequest extends Request {
  readonly validated?: {
    readonly params?: {
      readonly workspaceId?: string;
      readonly categoryId?: string;
      readonly articleId?: string;
      readonly revisionNumber?: number;
    };
  };
}

/** Shared actor-context builder for all KB controllers. */
export function kbContextOf(req: KbValidatedRequest): KbRequestContext {
  const workspace = req.workspace!;
  return {
    workspaceId: workspace.workspaceId,
    actorId: req.auth!.userId,
    role: resolveEffectiveRole(workspace),
  };
}

function categoryIdOf(req: KbValidatedRequest): string {
  return req.validated!.params!.categoryId!;
}

export const createCategoryController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as KbValidatedRequest;
  const result = await createCategoryFlow(
    kbContextOf(r),
    req.body as CreateCategoryInput,
  );
  sendSuccess(res, 201, result, req);
});

export const listCategoriesController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as KbValidatedRequest;
  sendSuccess(
    res,
    200,
    await listCategoriesFlow(kbContextOf(r), req.query as unknown as { page: number; limit: number }),
    req,
  );
});

export const getCategoryController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as KbValidatedRequest;
  sendSuccess(res, 200, await getCategoryFlow(kbContextOf(r), categoryIdOf(r)), req);
});

export const updateCategoryController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as KbValidatedRequest;
  sendSuccess(
    res,
    200,
    await updateCategoryFlow(kbContextOf(r), categoryIdOf(r), req.body as UpdateCategoryInput),
    req,
  );
});

export const archiveCategoryController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as KbValidatedRequest;
  sendSuccess(res, 200, { category: await archiveCategoryFlow(kbContextOf(r), categoryIdOf(r)) }, req);
});

export const restoreCategoryController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as KbValidatedRequest;
  sendSuccess(res, 200, { category: await restoreCategoryFlow(kbContextOf(r), categoryIdOf(r)) }, req);
});
