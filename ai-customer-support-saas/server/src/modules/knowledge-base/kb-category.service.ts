import { Types } from 'mongoose';

import { AppError } from '../../core/errors/app-error.js';
import { slugifyName } from '../workspaces/slug.js';

import {
  KB_AUDIT_ACTIONS,
  KB_RESOURCE_TYPES,
  recordKbAudit,
} from './kb-audit.js';
import {
  countArticlesActivelyReferencingCategory,
  countLiveChildCategories,
  createCategoryRecord,
  duplicateCategoryError,
  findCategoryInWorkspace,
  findCategoryIncludingArchived,
  isDuplicateCategorySlugError,
  listCategories,
  archiveCategoryRecord,
  restoreCategoryRecord,
  updateCategoryRecord,
} from './kb-category.repository.js';
import {
  toCategoryDto,
  type KbCategoryDetailPayload,
  type KbCategoryDto,
  type KbCategoryListPayload,
  type KbRequestContext,
} from './kb.dto.js';
import { MAX_KB_CATEGORY_DEPTH } from './kb.types.js';
import type { CreateCategoryInput, UpdateCategoryInput } from './kb.validation.js';

/**
 * Category business flows (controllers stay thin; authorization has ALREADY
 * run in middleware — this layer adds shape/hierarchy/lifecycle rules).
 *
 * Category laws:
 * - `slug` is a PURE function of `name` (workspaces/slug.ts slugifyName):
 *   "duplicate names" and "duplicate slugs" are one rule enforced by the
 *   `uniq_kb_category_slug_per_workspace` unique index — never a pre-insert
 *   existence check, which would race. A lost duplicate race surfaces as 409.
 * - Hierarchy is validated ONLY against live, same-workspace categories:
 *   the parent must exist (a foreign id reads exactly like an unknown id —
 *   404, no existence oracle), must not be the category itself (409), the
 *   parent's ancestor chain may not reach the moved category (409, cycle)
 *   and the resulting depth is bounded by MAX_KB_CATEGORY_DEPTH (422).
 * - Archiving is EXPLICIT about the tree: a category with live child
 *   categories or live (DRAFT/PUBLISHED) articles refused with 409 and
 *   counts — nothing silently detaches or orphans. Archived categories
 *   vanish from ordinary reads (live-only model hook) and return from
 *   restore; note a restored child may sit under an archived parent (both
 *   were archived together is impossible per the guard, but independent
 *   archives/tests can produce it) — the tree read treats it as detached.
 * - Workspace id comes from the validated middleware context; strict Zod
 *   schemas make workspaceId/parentId spoofing a structurally 422.
 */

const CATEGORY_NOT_FOUND = 'Category not found';

/**
 * Validates a proposed parent for a category about to be created or moved.
 *
 * Walks the parent's ancestor chain (bounded by the depth limit). Throws:
 * - 404 when the parent does not exist/live in this workspace,
 * - 409 when the chain reaches `selfId` (closing a cycle),
 * - 422 when the resulting node would sit deeper than the limit.
 */
async function validateProposedParent(
  workspaceId: Types.ObjectId,
  selfId: Types.ObjectId | null,
  proposedParentId: Types.ObjectId,
): Promise<void> {
  if (selfId !== null && proposedParentId.toHexString() === selfId.toHexString()) {
    throw AppError.conflict('A category cannot be its own parent');
  }

  // depth = number of ancestors above the category once attached. The parent
  // itself counts as ancestor #1.
  let depth = 0;
  let currentId: Types.ObjectId | null = proposedParentId;
  while (currentId !== null) {
    depth += 1; // the current node is an ancestor of the moved category
    if (depth > MAX_KB_CATEGORY_DEPTH - 1) {
      // +1 for the moved category itself ⇒ deeper than the limit.
      throw AppError.validation(
        `Category hierarchy must stay at most ${MAX_KB_CATEGORY_DEPTH} levels deep`,
      );
    }
    const parent = await findCategoryInWorkspace(workspaceId, currentId);
    if (parent === null) {
      throw AppError.notFound('Parent category not found');
    }
    if (selfId !== null && parent._id.toHexString() === selfId.toHexString()) {
      throw AppError.conflict('Category hierarchy would create a cycle');
    }
    currentId = parent.parentId;
  }
}

export async function createCategoryFlow(
  context: KbRequestContext,
  input: CreateCategoryInput,
): Promise<KbCategoryDetailPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const actorId = new Types.ObjectId(context.actorId);

  const slug = slugifyName(input.name);
  if (slug === null) {
    throw AppError.validation(
      'Category name contains no slug-safe characters; use letters, digits or hyphens',
    );
  }

  let parentId: Types.ObjectId | null = null;
  if (input.parentId !== undefined && input.parentId !== null) {
    parentId = new Types.ObjectId(input.parentId);
    // A brand-new category can never close a cycle, but the walk still
    // proves parent existence and bounds depth.
    await validateProposedParent(workspaceId, null, parentId);
  }

  try {
    const created = await createCategoryRecord(workspaceId, {
      name: input.name,
      slug,
      description: input.description ?? null,
      parentId,
      displayOrder: input.displayOrder ?? 0,
      createdById: actorId,
    });

    recordKbAudit({
      action: KB_AUDIT_ACTIONS.categoryCreated,
      workspaceId,
      actorId,
      resourceType: KB_RESOURCE_TYPES.category,
      resourceId: created._id.toHexString(),
      metadata: {
        fields: ['name', 'slug', 'description', 'parentId', 'displayOrder'],
        ...(parentId !== null ? { parentId: parentId.toHexString() } : {}),
      },
    });

    return { category: toCategoryDto(created) };
  } catch (error) {
    if (isDuplicateCategorySlugError(error)) throw duplicateCategoryError();
    throw error;
  }
}

export async function getCategoryFlow(
  context: KbRequestContext,
  categoryId: string,
): Promise<KbCategoryDetailPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const category = await findCategoryInWorkspace(workspaceId, new Types.ObjectId(categoryId));
  if (category === null) throw AppError.notFound(CATEGORY_NOT_FOUND);
  return { category: toCategoryDto(category) };
}

export async function listCategoriesFlow(
  context: KbRequestContext,
  query: { readonly page: number; readonly limit: number },
): Promise<KbCategoryListPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const result = await listCategories({
    workspaceId,
    page: query.page,
    limit: query.limit,
  });

  return {
    items: result.items.map((doc) => toCategoryDto(doc)),
    page: query.page,
    limit: query.limit,
    total: result.total,
    hasMore: result.hasMore,
  };
}

export async function updateCategoryFlow(
  context: KbRequestContext,
  categoryId: string,
  input: UpdateCategoryInput,
): Promise<KbCategoryDetailPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const actorId = new Types.ObjectId(context.actorId);
  const selfId = new Types.ObjectId(categoryId);

  const existing = await findCategoryInWorkspace(workspaceId, selfId);
  if (existing === null) throw AppError.notFound(CATEGORY_NOT_FOUND);

  let nameChange: { readonly name: string; readonly slug: string } | undefined;
  if (input.name !== undefined) {
    const derived = slugifyName(input.name);
    if (derived === null) {
      throw AppError.validation(
        'Category name contains no slug-safe characters; use letters, digits or hyphens',
      );
    }
    nameChange = { name: input.name, slug: derived };
  }

  const changedFields: string[] = [];
  if (input.name !== undefined) changedFields.push('name');
  if (input.description !== undefined) changedFields.push('description');
  if (input.displayOrder !== undefined) changedFields.push('displayOrder');
  if (input.parentId !== undefined) changedFields.push('parentId');

  let parentChange: Types.ObjectId | null | undefined;
  if (input.parentId !== undefined) {
    parentChange = input.parentId === null ? null : new Types.ObjectId(input.parentId);
    if (parentChange !== null) {
      // The moved category may not land inside its own subtree or above the
      // depth limit; re-parenting with the SAME parent is a harmless no-op
      // that still passes the walk.
      await validateProposedParent(workspaceId, selfId, parentChange);
    }
  }

  // Duplicate name/slug on rename → 409 (from the unique index, never a
  // pre-check). The scoped update applies ONLY the supplied fields.
  try {
    const updated = await updateCategoryRecord(workspaceId, selfId, {
      ...(nameChange !== undefined
        ? { name: nameChange.name, slug: nameChange.slug }
        : {}),
      ...(input.description !== undefined
        ? { description: input.description === '' ? null : input.description }
        : {}),
      ...(parentChange !== undefined ? { parentId: parentChange } : {}),
      ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
      updatedById: actorId,
    });
    if (updated === null) throw AppError.notFound(CATEGORY_NOT_FOUND);

    recordKbAudit({
      action: KB_AUDIT_ACTIONS.categoryUpdated,
      workspaceId,
      actorId,
      resourceType: KB_RESOURCE_TYPES.category,
      resourceId: updated._id.toHexString(),
      metadata: { fields: changedFields },
    });

    return { category: toCategoryDto(updated) };
  } catch (error) {
    if (isDuplicateCategorySlugError(error)) throw duplicateCategoryError();
    throw error;
  }
}

export async function archiveCategoryFlow(
  context: KbRequestContext,
  categoryId: string,
): Promise<KbCategoryDto> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const actorId = new Types.ObjectId(context.actorId);
  const selfId = new Types.ObjectId(categoryId);

  const existing = await findCategoryInWorkspace(workspaceId, selfId);
  if (existing === null) throw AppError.notFound(CATEGORY_NOT_FOUND);
  if (existing.archivedAt !== null) {
    throw AppError.conflict('Category is already archived');
  }

  // Explicit, non-silent behavior: refuse while live children or content
  // keep the category alive; counts travel in the error details.
  const liveChildren = await countLiveChildCategories(workspaceId, selfId);
  if (liveChildren > 0) {
    throw new AppError('Archive or move the child categories first', {
      statusCode: 409,
      code: 'CONFLICT',
      details: { liveChildCategories: liveChildren },
    });
  }
  const liveArticles = await countArticlesActivelyReferencingCategory(workspaceId, selfId);
  if (liveArticles > 0) {
    throw new AppError('Detach or archive the articles in this category first', {
      statusCode: 409,
      code: 'CONFLICT',
      details: { articlesInCategory: liveArticles },
    });
  }

  const archived = await archiveCategoryRecord(workspaceId, selfId, actorId);
  if (archived === null) throw AppError.notFound(CATEGORY_NOT_FOUND);

  recordKbAudit({
    action: KB_AUDIT_ACTIONS.categoryArchived,
    workspaceId,
    actorId,
    resourceType: KB_RESOURCE_TYPES.category,
    resourceId: archived._id.toHexString(),
  });

  return toCategoryDto(archived);
}

export async function restoreCategoryFlow(
  context: KbRequestContext,
  categoryId: string,
): Promise<KbCategoryDto> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const actorId = new Types.ObjectId(context.actorId);
  const selfId = new Types.ObjectId(categoryId);

  // Existence is checked INCLUDING archived (restore is the only path that
  // reaches archived categories); restoring a live category is a conflict.
  const includingArchived = await findCategoryIncludingArchived(workspaceId, selfId);
  if (includingArchived === null) throw AppError.notFound(CATEGORY_NOT_FOUND);
  if (includingArchived.archivedAt === null) {
    throw AppError.conflict('Category is not archived');
  }

  const restored = await restoreCategoryRecord(workspaceId, selfId, actorId);
  if (restored === null) throw AppError.notFound(CATEGORY_NOT_FOUND);

  recordKbAudit({
    action: KB_AUDIT_ACTIONS.categoryRestored,
    workspaceId,
    actorId,
    resourceType: KB_RESOURCE_TYPES.category,
    resourceId: restored._id.toHexString(),
  });

  return toCategoryDto(restored);
}
