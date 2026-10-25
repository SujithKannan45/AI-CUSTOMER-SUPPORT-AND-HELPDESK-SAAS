import { Types, type FilterQuery } from 'mongoose';

import { AppError } from '../../core/errors/index.js';
import { assertTenantScope, tenantFilter } from '../../database/tenant.js';

import type { KbArticleFilterSpec } from './kb.dto.js';
import { KbArticleModel, KbRevisionModel } from './kb.model.js';
import type { KbArticleDocument, KbRevisionDocument } from './kb.types.js';

/**
 * KB article + revision persistence layer — the ONLY module that touches the
 * `kb_articles` / `kb_article_revisions` collections (same conventions as the
 * ticket/conversation repositories):
 *
 * - EVERY query is built through `tenantFilter()` and asserted with
 *   `assertTenantScope()`; `_id` filters are ALWAYS composed here so foreign
 *   ids read as not-found (both the check and the concealment).
 * - Articles have NO hidden query hook: status filters are composed
 *   EXPLICITLY in this file (see kb.types.ts for the deliberate contrast with
 *   the category soft-delete convention).
 * - Revision numbers are allocated by an ATOMIC `$inc` on the article
 *   document — clients can never choose one, and concurrent editors can
 *   never draw the same number (the unique index is the backstop).
 * - This deployment has NO multi-document transactions (standalone mongod):
 *   article updates and revision writes are separate operations, and the
 *   services document the ordering/failure behavior honestly.
 */

/** Fields the repository writes at creation (validated by Zod upstream). */
export interface KbArticleCreateRecord {
  readonly categoryId: Types.ObjectId | null;
  readonly title: string;
  readonly slug: string;
  readonly summary: string;
  readonly body: string;
  readonly tags: string[];
  readonly createdById: Types.ObjectId;
}

export async function createArticleRecord(
  workspaceId: Types.ObjectId,
  record: KbArticleCreateRecord,
): Promise<KbArticleDocument> {
  return KbArticleModel.create({
    ...tenantFilter(workspaceId),
    categoryId: record.categoryId,
    title: record.title,
    slug: record.slug,
    summary: record.summary,
    body: record.body,
    tags: record.tags,
    status: 'DRAFT',
    currentRevisionNumber: 0, // Set to 1 when the creation snapshot persists.
    publishedAt: null,
    archivedAt: null,
    createdById: record.createdById,
    lastEditedById: record.createdById,
  });
}

/**
 * Slug-addressable published read for the PUBLIC layer: tenant +
 * `{ status: 'PUBLISHED' }` are composed here and nowhere else, so a draft,
 * archived or foreign article reads exactly as not-found. The PUBLIC read
 * path is the ONLY consumer — management reads key on ids.
 */
export async function findPublishedArticleBySlug(
  workspaceId: Types.ObjectId,
  articleSlug: string,
): Promise<KbArticleDocument | null> {
  const filter: FilterQuery<KbArticleDocument> = {
    ...tenantFilter(workspaceId),
    slug: articleSlug,
    status: 'PUBLISHED',
  };
  assertTenantScope(filter, 'findPublishedArticleBySlug');
  return KbArticleModel.findOne(filter);
}

/**
 * Reads ONE article by id, scoped to its workspace. Unlike categories there
 * is NO live-only hook: DRAFT and ARCHIVED articles come back too (management
 * APIs compose status filters at the service/query level explicitly).
 */
export async function findArticleInWorkspace(
  workspaceId: Types.ObjectId,
  articleId: Types.ObjectId,
): Promise<KbArticleDocument | null> {
  const filter: FilterQuery<KbArticleDocument> = {
    ...tenantFilter(workspaceId),
    _id: articleId,
  };
  assertTenantScope(filter, 'findArticleInWorkspace');
  return KbArticleModel.findOne(filter);
}

/**
 * Pins a freshly created article's revision counter from 0 to 1 after its
 * creation snapshot persisted (see kb-article.service.ts). Scoped to the
 * article AND the transient 0 state, so a lost race can never overwrite a
 * real allocated number.
 */
export async function pinInitialRevisionNumber(
  workspaceId: Types.ObjectId,
  articleId: Types.ObjectId,
): Promise<KbArticleDocument | null> {
  const filter: FilterQuery<KbArticleDocument> = {
    ...tenantFilter(workspaceId),
    _id: articleId,
    currentRevisionNumber: 0,
  };
  assertTenantScope(filter, 'pinInitialRevisionNumber');
  return KbArticleModel.findOneAndUpdate(
    filter,
    { $set: { currentRevisionNumber: 1 } },
    { new: true },
  );
}

/**
 * Atomically increments and reads the article's revision counter. `null`
 * means the article vanished between read and write (articles are never
 * deleted, so callers treat it defensively as not-found).
 */
export async function allocateNextRevisionNumber(
  workspaceId: Types.ObjectId,
  articleId: Types.ObjectId,
): Promise<number | null> {
  const filter: FilterQuery<KbArticleDocument> = {
    ...tenantFilter(workspaceId),
    _id: articleId,
  };
  assertTenantScope(filter, 'allocateNextRevisionNumber');
  const updated = await KbArticleModel.findOneAndUpdate(
    filter,
    { $inc: { currentRevisionNumber: 1 } },
    { new: true },
  );
  return updated?.currentRevisionNumber ?? null;
}

export interface KbRevisionWriteRecord {
  readonly articleId: Types.ObjectId;
  readonly revisionNumber: number;
  readonly title: string;
  readonly summary: string;
  readonly categoryId: Types.ObjectId | null;
  readonly tags: string[];
  readonly body: string;
  readonly editorId: Types.ObjectId;
  readonly changeSummary: string | null;
  readonly restoredFromRevisionNumber: number | null;
}

export async function createRevisionRecord(
  workspaceId: Types.ObjectId,
  record: KbRevisionWriteRecord,
): Promise<KbRevisionDocument> {
  return KbRevisionModel.create({
    ...tenantFilter(workspaceId),
    articleId: record.articleId,
    revisionNumber: record.revisionNumber,
    title: record.title,
    summary: record.summary,
    categoryId: record.categoryId,
    tags: record.tags,
    body: record.body,
    editorId: record.editorId,
    changeSummary: record.changeSummary,
    restoredFromRevisionNumber: record.restoredFromRevisionNumber,
  });
}

/**
 * Applies a CONTENT edit scoped to the tenant + article + non-archived state.
 * The `status: { $ne: 'ARCHIVED' }` condition closes the read-then-archive
 * race the service's status check cannot (callers surface `null` as 409).
 */
export async function updateArticleContent(
  workspaceId: Types.ObjectId,
  articleId: Types.ObjectId,
  patch: {
    readonly title?: string;
    readonly summary?: string;
    readonly body?: string;
    readonly categoryId?: Types.ObjectId | null;
    readonly tags?: string[];
    readonly lastEditedById: Types.ObjectId;
  },
): Promise<KbArticleDocument | null> {
  const filter: FilterQuery<KbArticleDocument> = {
    ...tenantFilter(workspaceId),
    _id: articleId,
    status: { $ne: 'ARCHIVED' },
  };
  assertTenantScope(filter, 'updateArticleContent');

  const set: Record<string, unknown> = { lastEditedById: patch.lastEditedById };
  if (patch.title !== undefined) set['title'] = patch.title;
  if (patch.summary !== undefined) set['summary'] = patch.summary;
  if (patch.body !== undefined) set['body'] = patch.body;
  if (patch.categoryId !== undefined) set['categoryId'] = patch.categoryId;
  if (patch.tags !== undefined) set['tags'] = patch.tags;

  return KbArticleModel.findOneAndUpdate(filter, { $set: set }, { new: true });
}

/**
 * Explicit slug rename (no revision — slugs are URLs, not content). Fails on
 * an archived article the same way content edits do (the model's slug doc
 * field is not lifecycle-gated; callers check status first, same as content).
 */
export async function updateArticleSlug(
  workspaceId: Types.ObjectId,
  articleId: Types.ObjectId,
  slug: string,
): Promise<KbArticleDocument | null> {
  const filter: FilterQuery<KbArticleDocument> = {
    ...tenantFilter(workspaceId),
    _id: articleId,
    status: { $ne: 'ARCHIVED' },
  };
  assertTenantScope(filter, 'updateArticleSlug');
  return KbArticleModel.findOneAndUpdate(filter, { $set: { slug } }, { new: true });
}

/**
 * One atomic lifecycle step (publish/unpublish/archive/restore). The
 * transition map is enforced in the SERVICE; the query repeats the FROM-side
 * status so concurrent lifecycle actions cannot double-apply.
 */
export async function applyArticleLifecycle(
  workspaceId: Types.ObjectId,
  articleId: Types.ObjectId,
  fromStatuses: readonly KbArticleDocument['status'][],
  toStatus: KbArticleDocument['status'],
  stamps: { readonly publishedAt: Date | null; readonly archivedAt: Date | null },
): Promise<KbArticleDocument | null> {
  const filter: FilterQuery<KbArticleDocument> = {
    ...tenantFilter(workspaceId),
    _id: articleId,
    status: { $in: [...fromStatuses] },
  };
  assertTenantScope(filter, 'applyArticleLifecycle');
  return KbArticleModel.findOneAndUpdate(
    filter,
    { $set: { status: toStatus, publishedAt: stamps.publishedAt, archivedAt: stamps.archivedAt } },
    { new: true },
  );
}

export interface KbArticleListResult {
  readonly items: readonly KbArticleDocument[];
  readonly total: number;
  readonly hasMore: boolean;
}

/**
 * Database-side filtered listing. All filters/sorts were validated and
 * allowlisted by Zod + the dto spec; the repository composes them under the
 * mandatory tenant scope (never raw client query objects).
 */
export async function listArticles(
  spec: KbArticleFilterSpec,
): Promise<KbArticleListResult> {
  const filter: FilterQuery<KbArticleDocument> = { ...tenantFilter(spec.workspaceId) };
  assertTenantScope(filter, 'listArticles');

  if (spec.status !== undefined) filter['status'] = spec.status;
  if (spec.categoryId !== undefined) filter['categoryId'] = new Types.ObjectId(spec.categoryId);
  if (spec.authorId !== undefined) filter['createdById'] = new Types.ObjectId(spec.authorId);
  if (spec.tags !== undefined && spec.tags.length > 0) {
    filter['tags'] = { $all: spec.tags };
  }

  const dateRanges: Record<string, unknown> = {};
  if (spec.createdFrom !== undefined || spec.createdTo !== undefined) {
    dateRanges['createdAt'] = {
      ...(spec.createdFrom !== undefined ? { $gte: spec.createdFrom } : {}),
      ...(spec.createdTo !== undefined ? { $lte: spec.createdTo } : {}),
    };
  }
  if (spec.updatedFrom !== undefined || spec.updatedTo !== undefined) {
    dateRanges['updatedAt'] = {
      ...(spec.updatedFrom !== undefined ? { $gte: spec.updatedFrom } : {}),
      ...(spec.updatedTo !== undefined ? { $lte: spec.updatedTo } : {}),
    };
  }
  for (const [key, value] of Object.entries(dateRanges)) filter[key] = value;

  if (spec.search !== undefined && spec.search.length > 0) {
    // Tenant-slice case-insensitive substring scan on title + summary — the
    // same documented tradeoff as customers/tickets (no text index yet; the
    // future AI retrieval phase supersedes it, so an Atlas Search dependency
    // is deliberately deferred). Regex metacharacters are escaped; no client
    // string is ever evaluated as a query object.
    const escaped = spec.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter['$or'] = [
      { title: { $regex: escaped, $options: 'i' } },
      { summary: { $regex: escaped, $options: 'i' } },
    ];
  }

  const direction = spec.order === 'asc' ? 1 : -1;
  const sortField = spec.sort ?? 'createdAt';

  const [items, total] = await Promise.all([
    KbArticleModel.find(filter)
      .sort({ [sortField]: direction, _id: 1 })
      .skip((spec.page - 1) * spec.limit)
      .limit(spec.limit),
    KbArticleModel.countDocuments(filter),
  ]);

  return { items, total, hasMore: spec.page * spec.limit < total };
}

// ── Revisions ────────────────────────────────────────────────────────────────

export interface KbRevisionListResult {
  readonly items: readonly KbRevisionDocument[];
  readonly total: number;
  readonly hasMore: boolean;
}

export async function listRevisions(
  spec: {
    readonly workspaceId: Types.ObjectId;
    readonly articleId: Types.ObjectId;
    readonly page: number;
    readonly limit: number;
  },
): Promise<KbRevisionListResult> {
  const filter: FilterQuery<KbRevisionDocument> = {
    ...tenantFilter(spec.workspaceId),
    articleId: spec.articleId,
  };
  assertTenantScope(filter, 'listRevisions');

  const [items, total] = await Promise.all([
    KbRevisionModel.find(filter)
      .sort({ revisionNumber: -1 })
      .skip((spec.page - 1) * spec.limit)
      .limit(spec.limit),
    KbRevisionModel.countDocuments(filter),
  ]);

  return { items, total, hasMore: spec.page * spec.limit < total };
}

export async function findRevisionInWorkspace(
  workspaceId: Types.ObjectId,
  articleId: Types.ObjectId,
  revisionNumber: number,
): Promise<KbRevisionDocument | null> {
  const filter: FilterQuery<KbRevisionDocument> = {
    ...tenantFilter(workspaceId),
    articleId,
    revisionNumber,
  };
  assertTenantScope(filter, 'findRevisionInWorkspace');
  return KbRevisionModel.findOne(filter);
}

export function isDuplicateArticleSlugError(error: unknown): boolean {
  const candidate = error as { code?: unknown } | null;
  if (candidate === null || typeof candidate !== 'object') return false;
  return candidate['code'] === 11000;
}

export function duplicateArticleSlugError(): AppError {
  return AppError.conflict('An article with this slug already exists in this workspace');
}
