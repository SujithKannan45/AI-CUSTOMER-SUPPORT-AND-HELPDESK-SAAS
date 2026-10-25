import { type Types, type FilterQuery } from 'mongoose';

import { AppError } from '../../core/errors/index.js';
import { assertTenantScope, tenantFilter } from '../../database/tenant.js';

import { KB_CATEGORY_WITH_ARCHIVE, KbCategoryModel } from './kb.model.js';
import type { KbCategoryDocument } from './kb.types.js';

/**
 * KB category persistence layer — the ONLY module that touches the
 * `kb_categories` collection, mirroring the ticket/conversation repositories:
 *
 * - EVERY query is built through `tenantFilter()` and asserted with
 *   `assertTenantScope()`. Document `_id` and parent references are ALWAYS
 *   composed here, so no caller can fetch "a category id" without the
 *   workspace scope — foreign ids read as not-found (check and concealment).
 * - The model's live-only hook (archivedAt filter) applies by default;
 *   `findCategoryIncludingArchived` opts out explicitly for the restore path.
 * - Mutations are SCOPED `findOneAndUpdate`s — never read-then-write on a
 *   document the caller handed us.
 */

/** Fields computed upper-stream (validated by Zod, slug derived in service). */
export interface KbCategoryCreateRecord {
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly parentId: Types.ObjectId | null;
  readonly displayOrder: number;
  readonly createdById: Types.ObjectId;
}

export async function createCategoryRecord(
  workspaceId: Types.ObjectId,
  record: KbCategoryCreateRecord,
): Promise<KbCategoryDocument> {
  return KbCategoryModel.create({
    ...tenantFilter(workspaceId),
    name: record.name,
    slug: record.slug,
    description: record.description,
    parentId: record.parentId,
    displayOrder: record.displayOrder,
    createdById: record.createdById,
    updatedById: record.createdById,
  });
}

/**
 * Reads ONE LIVE category by id, scoped to its workspace. `null` for unknown
 * ids, foreign ids or archived categories — one lookup answers "does this
 * category exist, live, and here?".
 */
export async function findCategoryInWorkspace(
  workspaceId: Types.ObjectId,
  categoryId: Types.ObjectId,
): Promise<KbCategoryDocument | null> {
  const filter: FilterQuery<KbCategoryDocument> = {
    ...tenantFilter(workspaceId),
    _id: categoryId,
  };
  assertTenantScope(filter, 'findCategoryInWorkspace');
  return KbCategoryModel.findOne(filter);
}

/** Archive-restore path: reads including archived categories. */
export async function findCategoryIncludingArchived(
  workspaceId: Types.ObjectId,
  categoryId: Types.ObjectId,
): Promise<KbCategoryDocument | null> {
  const filter: FilterQuery<KbCategoryDocument> = {
    ...tenantFilter(workspaceId),
    _id: categoryId,
  };
  assertTenantScope(filter, 'findCategoryIncludingArchived');
  return KbCategoryModel.findOne(filter).setOptions(KB_CATEGORY_WITH_ARCHIVE);
}

export interface KbCategoryListResult {
  readonly items: readonly KbCategoryDocument[];
  readonly total: number;
  readonly hasMore: boolean;
}

/**
 * Live categories ordered for the management/public tree: displayOrder then
 * name, with `_id` as the deterministic tiebreak. Live-only (model hook).
 */
export async function listCategories(
  spec: { readonly workspaceId: Types.ObjectId; readonly page: number; readonly limit: number },
): Promise<KbCategoryListResult> {
  const filter: FilterQuery<KbCategoryDocument> = tenantFilter(spec.workspaceId);
  assertTenantScope(filter, 'listCategories');

  const [items, total] = await Promise.all([
    KbCategoryModel.find(filter)
      .sort({ displayOrder: 1, name: 1, _id: 1 })
      .skip((spec.page - 1) * spec.limit)
      .limit(spec.limit),
    KbCategoryModel.countDocuments(filter),
  ]);

  return { items, total, hasMore: spec.page * spec.limit < total };
}

/**
 * Scoped category mutation. Duplicate-key failures (slug renamed onto an
 * existing one) propagate — the SERVICE translates `uniq_kb_category_slug_per_workspace`
 * into a 409 (see translateCategoryDuplicate below).
 */
export async function updateCategoryRecord(
  workspaceId: Types.ObjectId,
  categoryId: Types.ObjectId,
  patch: {
    readonly name?: string;
    readonly slug?: string;
    readonly description?: string | null;
    readonly parentId?: Types.ObjectId | null;
    readonly displayOrder?: number;
    readonly updatedById: Types.ObjectId;
  },
): Promise<KbCategoryDocument | null> {
  const filter: FilterQuery<KbCategoryDocument> = {
    ...tenantFilter(workspaceId),
    _id: categoryId,
  };
  assertTenantScope(filter, 'updateCategoryRecord');

  const set: Record<string, unknown> = { updatedById: patch.updatedById };
  if (patch.name !== undefined) set['name'] = patch.name;
  if (patch.slug !== undefined) set['slug'] = patch.slug;
  if (patch.description !== undefined) set['description'] = patch.description;
  if (patch.parentId !== undefined) set['parentId'] = patch.parentId;
  if (patch.displayOrder !== undefined) set['displayOrder'] = patch.displayOrder;

  return KbCategoryModel.findOneAndUpdate(filter, { $set: set }, { new: true });
}

export async function countLiveChildCategories(
  workspaceId: Types.ObjectId,
  categoryId: Types.ObjectId,
): Promise<number> {
  const filter: FilterQuery<KbCategoryDocument> = {
    ...tenantFilter(workspaceId),
    parentId: categoryId,
  };
  assertTenantScope(filter, 'countLiveChildCategories');
  return KbCategoryModel.countDocuments(filter);
}

/**
 * Categories with LIVE content attached may not be archived (explicit guard
 * in the service). DRAFT/PUBLISHED articles keep the reference usable;
 * ARCHIVED articles' references are stale history, not a blocker.
 */
export async function countArticlesActivelyReferencingCategory(
  workspaceId: Types.ObjectId,
  categoryId: Types.ObjectId,
): Promise<number> {
  const { KbArticleModel } = await import('./kb.model.js');
  const filter: Record<string, unknown> = {
    ...tenantFilter(workspaceId),
    categoryId,
    status: { $in: ['DRAFT', 'PUBLISHED'] },
  };
  assertTenantScope(filter, 'countArticlesActivelyReferencingCategory');
  return KbArticleModel.countDocuments(filter);
}

export async function archiveCategoryRecord(
  workspaceId: Types.ObjectId,
  categoryId: Types.ObjectId,
  editorId: Types.ObjectId,
): Promise<KbCategoryDocument | null> {
  const filter: FilterQuery<KbCategoryDocument> = {
    ...tenantFilter(workspaceId),
    _id: categoryId,
  };
  assertTenantScope(filter, 'archiveCategoryRecord');
  return KbCategoryModel.findOneAndUpdate(
    filter,
    { $set: { archivedAt: new Date(), updatedById: editorId } },
    { new: true },
  );
}

export async function restoreCategoryRecord(
  workspaceId: Types.ObjectId,
  categoryId: Types.ObjectId,
  editorId: Types.ObjectId,
): Promise<KbCategoryDocument | null> {
  const filter: FilterQuery<KbCategoryDocument> = {
    ...tenantFilter(workspaceId),
    _id: categoryId,
    archivedAt: { $ne: null },
  };
  assertTenantScope(filter, 'restoreCategoryRecord');
  return KbCategoryModel.findOneAndUpdate(
    filter,
    { $set: { archivedAt: null, updatedById: editorId } },
    { new: true },
  );
}

/**
 * True when the error is a duplicate-key on the category slug scope
 * (`uniq_kb_category_slug_per_workspace`). Any other duplicate is a
 * programming error and is rethrown untouched.
 */
export function isDuplicateCategorySlugError(error: unknown): boolean {
  const candidate = error as { code?: unknown; keyValue?: Record<string, unknown> } | null;
  if (candidate === null || typeof candidate !== 'object') return false;
  if (candidate['code'] !== 11000) return false;
  return candidate['keyValue']?.['slug'] !== undefined;
}

export function duplicateCategoryError(): AppError {
  return AppError.conflict('A category with this name already exists in this workspace');
}
