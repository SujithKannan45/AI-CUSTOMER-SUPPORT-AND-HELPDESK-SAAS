import { Types } from 'mongoose';

import { AppError } from '../../core/errors/app-error.js';
import { logger } from '../../core/logger/logger.js';
import {
  scheduleArticleChunkIndexing,
  scheduleSourceChunkIneligibility,
  scheduleSourceChunkPurge,
} from '../rag/rag.triggers.js';
import { normalizeSlug, isValidSlug, slugValidationError, slugifyName } from '../workspaces/slug.js';


import {
  allocateNextRevisionNumber,
  applyArticleLifecycle,
  pinInitialRevisionNumber,
  createArticleRecord,
  createRevisionRecord,
  duplicateArticleSlugError,
  findArticleInWorkspace,
  findRevisionInWorkspace,
  isDuplicateArticleSlugError,
  listArticles,
  listRevisions,
  updateArticleContent,
  updateArticleSlug,
} from './kb-article.repository.js';
import {
  KB_AUDIT_ACTIONS,
  KB_RESOURCE_TYPES,
  recordKbAudit,
} from './kb-audit.js';
import { findCategoryInWorkspace } from './kb-category.repository.js';
import {
  toArticleDto,
  toArticleSummaryDto,
  toRevisionDto,
  toRevisionSummaryDto,
  type KbArticleCreatedPayload,
  type KbArticleDetailPayload,
  type KbArticleListPayload,
  type KbRequestContext,
  type KbRevisionDetailPayload,
  type KbRevisionListPayload,
  type KbArticleFilterSpec,
  type KbArticleDto,
} from './kb.dto.js';
import { type KbArticleDocument ,
  KB_ARTICLE_TRANSITIONS,
  KB_SLUG_AUTO_RETRY_LIMIT,
} from './kb.types.js';
import type {
  CreateArticleInput,
  ListArticlesQuery,
  UpdateArticleInput,
} from './kb.validation.js';

/**
 * Article business flows (controllers stay thin; authorization has ALREADY
 * run in middleware — `kb.manage` gates ALL mutations at the route layer; a
 * self-service KB would extend the registry, not bypass it).
 *
 * Lifecycle ⇄ revision rules:
 * - Creating an article writes revision 1 (an exact snapshot of the initial
 *   content). A failed revision write NEVER masquerades as success: the
 *   request fails loudly, and the design tolerates the documented gap of the
 *   counter being ahead (see the consistency note below).
 * - CONTENT changes (title/summary/body/category/tags) always allocate the
 *   next revision number with an ATOMIC `$inc` on the article document and
 *   write a full snapshot (title, summary, body, categoryId, tags, editor,
 *   optional change summary) BEFORE the article content update is applied.
 *   Restoring an old revision likewise CREATES A NEW revision (history is
 *   never rewritten or deleted — the revisions collection is append-only at
 *   the model layer).
 * - Lifecycle steps (publish/unpublish/archive/restore) are NOT content
 *   changes — they produce no revisions. Publish fires only from DRAFT,
 *   unpublish from PUBLISHED, archive from DRAFT/PUBLISHED, restore from
 *   ARCHIVED; anything else is a 409 conflict. Content/slug edits are
 *   rejected while ARCHIVED (restore first).
 * - `publishedAt` is set on publish and cleared on unpublish/restore;
 *   `archivedAt` is set on archive and cleared on restore. There is no
 *   scheduled-publish support (no scheduler infra exists — see kb.types.ts).
 *
 * Consistency (documented honestly — NO transactions in this deployment,
 * standalone MongoDB):
 * - revision-number allocation (`$inc`) is atomic, but the revision INSERT
 *   and the article content `$set` are NOT atomic together. The order is:
 *   allocate → insert revision → update article. If the insert fails, the
 *   counter is already ahead and the request fails as a 500 (no fake
 *   success; the counter gap self-consistently yields the NEXT number for
 *   the following edit). If the content update fails after the insert, the
 *   snapshot exists while the stored article lags it — the article remains
 *   the read model and the next successful content edit creates the next
 *   revision; every such failure is logged at error level.
 * - Slug conflicts are resolved exclusively through the
 *   `uniq_kb_article_slug_per_workspace` unique index (never a pre-check):
 *   client-supplied slugs 409 immediately; auto-derived slugs retry a
 *   bounded, deterministic `-2…-25` suffix series before giving up with 409.
 * - Workflow flags for future phases: the `{ status: 'PUBLISHED' }`
 *   predicate (`KB_PUBLISHED_FILTER`) is the single retrieval contract for
 *   the AI/RAG and public-read consumers; no embeddings/derived content is
 *   stored on the article model.
 */

const ARTICLE_NOT_FOUND = 'Article not found';
const REVISION_NOT_FOUND = 'Revision not found';

export interface ContentChange {
  readonly title?: string;
  readonly summary?: string;
  readonly body?: string;
  readonly categoryId?: Types.ObjectId | null;
  readonly tags?: string[];
}

/** Detects whether a PATCH actually alters content (revision-relevant). */
function contentDiff(existing: {
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly categoryId: Types.ObjectId | null;
  readonly tags: string[];
}, input: UpdateArticleInput): ContentChange | null {
  const change: Record<string, unknown> = {};

  if (input.title !== undefined && input.title !== existing.title) {
    change['title'] = input.title;
  }
  if (
    input.summary !== undefined &&
    (input.summary ?? '') !== existing.summary
  ) {
    change['summary'] = input.summary ?? '';
  }
  if (input.body !== undefined && input.body !== existing.body) {
    change['body'] = input.body;
  }
  if (input.categoryId !== undefined) {
    const newCategoryId = input.categoryId === null ? null : new Types.ObjectId(input.categoryId);
    const existingId = existing.categoryId === null ? null : existing.categoryId.toHexString();
    const newId = newCategoryId === null ? null : newCategoryId.toHexString();
    if (newId !== existingId) change['categoryId'] = newCategoryId;
  }
  if (input.tags !== undefined && !sameTagSet(input.tags, existing.tags)) {
    change['tags'] = input.tags;
  }

  return Object.keys(change).length === 0 ? null : (change);
}

/** Order-insensitive set compare (the model dedupes/normalizes on write). */
function sameTagSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((tag, index) => tag === sortedB[index]);
}

/** Normalizes + validates a client-supplied article slug. */
function resolveClientSlug(raw: string): string {
  const normalized = normalizeSlug(raw);
  if (!isValidSlug(normalized)) {
    throw AppError.validation(slugValidationError(normalized));
  }
  return normalized;
}

async function requireArticle(
  workspaceId: Types.ObjectId,
  articleId: string,
): Promise<Types.ObjectId> {
  const article = await findArticleInWorkspace(workspaceId, new Types.ObjectId(articleId));
  if (article === null) throw AppError.notFound(ARTICLE_NOT_FOUND);
  return article._id;
}

// ── Creation ─────────────────────────────────────────────────────────────────

export async function createArticleFlow(
  context: KbRequestContext,
  input: CreateArticleInput,
): Promise<KbArticleCreatedPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const actorId = new Types.ObjectId(context.actorId);

  let categoryId: Types.ObjectId | null = null;
  if (input.categoryId !== undefined && input.categoryId !== null) {
    categoryId = new Types.ObjectId(input.categoryId);
    const category = await findCategoryInWorkspace(workspaceId, categoryId);
    if (category === null) throw AppError.notFound('Category not found');
  }

  const clientSlug =
    input.slug !== undefined ? resolveClientSlug(input.slug) : undefined;
  const slugBase =
    clientSlug ?? slugifyName(input.title);
  if (slugBase === null) {
    throw AppError.validation(
      'Title contains no slug-safe characters; provide an explicit slug',
    );
  }

  // Auto-derived slugs retry a deterministic suffix series; client slugs are
  // a single attempt (conflict → 409, their rename is explicit).
  const candidates =
    clientSlug !== undefined
      ? [clientSlug]
      : generateSlugCandidates(slugBase);
  for (const candidate of candidates) {
    try {
      const created = await createArticleRecord(workspaceId, {
        categoryId,
        title: input.title,
        slug: candidate,
        summary: input.summary ?? '',
        body: input.body,
        // Model schema dedupes/trims tags again as defense-in-depth.
        tags: input.tags ?? [],
        createdById: actorId,
      });
      const withSnapshot = await ensureCreationSnapshot(workspaceId, created, actorId);

      recordKbAudit({
        action: KB_AUDIT_ACTIONS.articleCreated,
        workspaceId,
        actorId,
        resourceType: KB_RESOURCE_TYPES.article,
        resourceId: created._id.toHexString(),
        metadata: {
          slug: withSnapshot.slug,
          categoryId,
          ...(categoryId !== null ? { categoryId: categoryId.toHexString() } : {}),
        },
      });

      return { article: toArticleDto(withSnapshot) };
    } catch (error) {
      if (isDuplicateArticleSlugError(error)) continue;
      throw error;
    }
  }
  throw duplicateArticleSlugError();
}

/** deterministic, bounded auto-slug candidates: base, -2…-25. */
function* generateSlugCandidates(base: string): Generator<string> {
  yield base;
  for (let index = 2; index <= KB_SLUG_AUTO_RETRY_LIMIT + 1; index += 1) {
    yield `${base}-${index}`;
  }
}

/**
 * Writes the revision-1 snapshot for a fresh article and pins the counter.
 * Documented consistency: if the snapshot cannot persist, the request fails
 * loudly (the article keeps its content; the counter stays 0 and the NEXT
 * content change allocates normally) — never silent success.
 */
async function ensureCreationSnapshot(
  workspaceId: Types.ObjectId,
  article: KbArticleDocument,
  editorId: Types.ObjectId,
): Promise<KbArticleDocument> {
  // Snapshot FIRST: a failed write aborts loudly and leaves the counter at 0
  // — the request never masquerades as success, and the next content change
  // allocates normally from the unpinned state (no fake numbering).
  await createRevisionRecord(workspaceId, {
    articleId: article._id,
    revisionNumber: 1,
    title: article.title,
    summary: article.summary,
    categoryId: article.categoryId,
    tags: [...article.tags],
    body: article.body,
    editorId,
    changeSummary: null,
    restoredFromRevisionNumber: null,
  });
  // Pin the counter to 1, scoped to the transient state so a lost race can
  // never clobber a real allocation.
  const pinned = await pinInitialRevisionNumber(workspaceId, article._id);
  if (pinned === null) {
    logger.error(
      { workspaceId: workspaceId.toHexString(), articleId: article._id.toHexString() },
      'KB creation snapshot persisted but the revision pin lost its race',
    );
  }
  return pinned ?? article;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getArticleFlow(
  context: KbRequestContext,
  articleId: string,
): Promise<KbArticleDetailPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const article = await findArticleInWorkspace(workspaceId, new Types.ObjectId(articleId));
  if (article === null) throw AppError.notFound(ARTICLE_NOT_FOUND);
  return { article: toArticleDto(article) };
}

export async function listArticlesFlow(
  context: KbRequestContext,
  query: ListArticlesQuery,
): Promise<KbArticleListPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);

  const spec: KbArticleFilterSpec = {
    workspaceId,
    page: query.page,
    limit: query.limit,
    ...(query.search !== undefined ? { search: query.search } : {}),
    ...(query.categoryId !== undefined ? { categoryId: query.categoryId } : {}),
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.authorId !== undefined ? { authorId: query.authorId } : {}),
    ...(query.tags !== undefined && query.tags !== ''
      ? { tags: query.tags.split(',').map((t) => t.trim()).filter(Boolean) }
      : {}),
    ...(query.createdFrom !== undefined ? { createdFrom: query.createdFrom } : {}),
    ...(query.createdTo !== undefined ? { createdTo: query.createdTo } : {}),
    ...(query.updatedFrom !== undefined ? { updatedFrom: query.updatedFrom } : {}),
    ...(query.updatedTo !== undefined ? { updatedTo: query.updatedTo } : {}),
    ...(query.sort !== undefined ? { sort: query.sort } : {}),
    ...(query.order !== undefined ? { order: query.order } : {}),
  };

  const result = await listArticles(spec);
  return {
    items: result.items.map((doc) => toArticleSummaryDto(doc)),
    page: query.page,
    limit: query.limit,
    total: result.total,
    hasMore: result.hasMore,
  };
}

// ── Content edits ────────────────────────────────────────────────────────────

export async function updateArticleFlow(
  context: KbRequestContext,
  articleId: string,
  input: UpdateArticleInput,
): Promise<KbArticleDto> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const actorId = new Types.ObjectId(context.actorId);
  const selfId = new Types.ObjectId(articleId);

  const existing = await findArticleInWorkspace(workspaceId, selfId);
  if (existing === null) throw AppError.notFound(ARTICLE_NOT_FOUND);
  if (existing.status === 'ARCHIVED') {
    throw AppError.conflict('Restore the article before editing it');
  }

  const contentChange = contentDiff(existing, input);
  const changedFields: string[] = [];
  changedFields.push(...Object.keys(contentChange ?? {}));
  const slugChange =
    input.slug !== undefined && resolveClientSlug(input.slug) !== existing.slug
      ? resolveClientSlug(input.slug)
      : undefined;
  if (slugChange !== undefined) changedFields.push('slug');

  if (contentChange === null && slugChange === undefined) {
    return toArticleDto(existing); // no-op PATCH → current state
  }

  if (contentChange === null) {
    // Slug-only edit: no content revision (slugs are URLs, not content).
    await applySlugChange(workspaceId, selfId, slugChange!);
  } else {
    // Validate any new category BEFORE touching history: same-workspace AND
    // live (an archived category is not attachable).
    const newCategoryId = contentChange.categoryId;
    if (newCategoryId !== undefined && newCategoryId !== null) {
      const category = await findCategoryInWorkspace(workspaceId, newCategoryId);
      if (category === null) throw AppError.notFound('Category not found');
    }

    const revisionNumber = await allocateNextRevisionNumber(workspaceId, selfId);
    if (revisionNumber === null) throw AppError.notFound(ARTICLE_NOT_FOUND);

    try {
      // Snapshot FIRST: a failed revision write aborts the edit loudly —
      // the article's stored content stays untouched (never a fake success).
      await createRevisionRecord(workspaceId, {
        articleId: selfId,
        revisionNumber,
        title: contentChange.title ?? existing.title,
        summary: contentChange.summary ?? existing.summary,
        categoryId:
          contentChange.categoryId !== undefined
            ? contentChange.categoryId
            : existing.categoryId,
        tags: contentChange.tags ?? [...existing.tags],
        body: contentChange.body ?? existing.body,
        editorId: actorId,
        changeSummary: input.changeSummary ?? null,
        restoredFromRevisionNumber: null,
      });

      const updated = await updateArticleContent(workspaceId, selfId, {
        ...contentChange,
        lastEditedById: actorId,
      });
      if (updated === null) {
        // The article kept its old content but the counter moved ahead; the
        // revision records the attempted submission. Loud, logged, honest.
        logger.error(
          {
            workspaceId: workspaceId.toHexString(),
            articleId: selfId.toHexString(),
            revisionNumber,
          },
          'KB content update lost after its revision snapshot persisted',
        );
        throw new AppError('Article content update failed after revision persistence', {
          statusCode: 500,
          code: 'KB_ARTICLE_UPDATE_FAILED',
          isOperational: false,
        });
      }

      if (slugChange !== undefined) {
        try {
          await applySlugChange(workspaceId, selfId, slugChange);
        } catch (error) {
          if (isDuplicateArticleSlugError(error)) throw duplicateArticleSlugError();
          throw error;
        }
      }

      recordKbAudit({
        action: KB_AUDIT_ACTIONS.articleUpdated,
        workspaceId,
        actorId,
        resourceType: KB_RESOURCE_TYPES.article,
        resourceId: selfId.toHexString(),
        metadata: { fields: changedFields, revisionNumber },
      });

      // A PUBLISHED article's content changed: let the RAG projection catch
      // up fire-safe (chunking + reindex are idempotent by design).
      if (updated.status === 'PUBLISHED') {
        scheduleArticleChunkIndexing(workspaceId.toHexString(), selfId.toHexString());
      }

      const refreshed = await findArticleInWorkspace(workspaceId, selfId);
      return toArticleDto(refreshed ?? updated);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (isDuplicateArticleSlugError(error)) throw duplicateArticleSlugError();
      throw error;
    }
  }

  recordKbAudit({
    action: KB_AUDIT_ACTIONS.articleUpdated,
    workspaceId,
    actorId,
    resourceType: KB_RESOURCE_TYPES.article,
    resourceId: selfId.toHexString(),
    metadata: { fields: changedFields },
  });
  const refreshed = await findArticleInWorkspace(workspaceId, selfId);
  if (refreshed === null) throw AppError.notFound(ARTICLE_NOT_FOUND);
  return toArticleDto(refreshed);
}

async function applySlugChange(
  workspaceId: Types.ObjectId,
  articleId: Types.ObjectId,
  slug: string,
): Promise<void> {
  const updated = await updateArticleSlug(workspaceId, articleId, slug);
  if (updated === null) {
    throw AppError.conflict('Restore the article before editing it');
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

const ACTION_TO_AUDIT = {
  publish: KB_AUDIT_ACTIONS.articlePublished,
  unpublish: KB_AUDIT_ACTIONS.articleUnpublished,
  archive: KB_AUDIT_ACTIONS.articleArchived,
  restore: KB_AUDIT_ACTIONS.articleRestored,
} as const;

export async function articleLifecycleFlow(
  context: KbRequestContext,
  articleId: string,
  action: keyof typeof KB_ARTICLE_TRANSITIONS,
): Promise<KbArticleDto> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const actorId = new Types.ObjectId(context.actorId);
  const selfId = new Types.ObjectId(articleId);

  // Existence is checked FIRST (workspace-scoped) so a missing/neighboring-
  // tenant id is a 404 — never the 409 "wrong state" that the update filter
  // alone would report (which would leak lifecycle state to outsiders).
  await requireArticle(workspaceId, articleId);

  const transition = KB_ARTICLE_TRANSITIONS[action];
  let result;
  try {
    result = await applyArticleLifecycle(
      workspaceId,
      selfId,
      transition.from,
      transition.to,
      {
        publishedAt: transition.to === 'PUBLISHED' ? new Date() : null,
        archivedAt: transition.to === 'ARCHIVED' ? new Date() : null,
      },
    );
  } catch (error) {
    if (isDuplicateArticleSlugError(error)) throw duplicateArticleSlugError();
    throw error;
  }
  if (result === null) {
    // Same workspace, wrong lifecycle state → genuine conflict.
    throw AppError.conflict(
      `Article is not in a state that permits ${action} (required: ${transition.from.join(' or ')})`,
    );
  }

  recordKbAudit({
    action: ACTION_TO_AUDIT[action],
    workspaceId,
    actorId,
    resourceType: KB_RESOURCE_TYPES.article,
    resourceId: result._id.toHexString(),
    metadata: { from: transition.from, to: transition.to },
  });

  // RAG projection (Prompt 13) — fire-safe, per-source lifecycle wiring.
  switch (transition.to) {
    case 'PUBLISHED':
      scheduleArticleChunkIndexing(workspaceId.toHexString(), selfId.toHexString());
      break;
    case 'ARCHIVED':
      scheduleSourceChunkPurge(workspaceId.toHexString(), 'KB_ARTICLE', selfId.toHexString());
      break;
    case 'DRAFT':
      // Unpublish/restore → hide from retrieval cheaply (a republish reuses
      // the stored embeddings via the text-hash path).
      scheduleSourceChunkIneligibility(workspaceId.toHexString(), 'KB_ARTICLE', selfId.toHexString());
      break;
  }

  return toArticleDto(result);
}

// ── Revisions ────────────────────────────────────────────────────────────────

export async function listRevisionsFlow(
  context: KbRequestContext,
  articleId: string,
  query: { readonly page: number; readonly limit: number },
): Promise<KbRevisionListPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  await requireArticle(workspaceId, articleId);

  const result = await listRevisions({
    workspaceId,
    articleId: new Types.ObjectId(articleId),
    page: query.page,
    limit: query.limit,
  });

  return {
    items: result.items.map((doc) => toRevisionSummaryDto(doc)),
    page: query.page,
    limit: query.limit,
    total: result.total,
    hasMore: result.hasMore,
  };
}

export async function getRevisionFlow(
  context: KbRequestContext,
  articleId: string,
  revisionNumber: number,
): Promise<KbRevisionDetailPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  await requireArticle(workspaceId, articleId);

  const revision = await findRevisionInWorkspace(
    workspaceId,
    new Types.ObjectId(articleId),
    revisionNumber,
  );
  if (revision === null) throw AppError.notFound(REVISION_NOT_FOUND);
  return { revision: toRevisionDto(revision) };
}

/**
 * Restoring an older revision CREATES a new revision — history is never
 * rewritten. The new snapshot carries the OLD revision's content, the
 * current actor as editor, a fixed change summary and a
 * `restoredFromRevisionNumber` pointer. Restoring into an ARCHIVED article
 * is refused (restore the article first).
 */
export async function restoreRevisionFlow(
  context: KbRequestContext,
  articleId: string,
  revisionNumber: number,
): Promise<KbRevisionDetailPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const actorId = new Types.ObjectId(context.actorId);
  const selfId = new Types.ObjectId(articleId);

  const existing = await findArticleInWorkspace(workspaceId, selfId);
  if (existing === null) throw AppError.notFound(ARTICLE_NOT_FOUND);
  if (existing.status === 'ARCHIVED') {
    throw AppError.conflict('Restore the article before editing it');
  }

  const sourceRevision = await findRevisionInWorkspace(workspaceId, selfId, revisionNumber);
  if (sourceRevision === null) throw AppError.notFound(REVISION_NOT_FOUND);

  const newNumber = await allocateNextRevisionNumber(workspaceId, selfId);
  if (newNumber === null) throw AppError.notFound(ARTICLE_NOT_FOUND);

  // Restore passes content through AS RECORDED: a stale categoryId
  // (category since archived/deleted) stays a dangling reference by design —
  // consumers resolve it to null; the next content edit revalidates.
  const revision = await createRevisionRecord(workspaceId, {
    articleId: selfId,
    revisionNumber: newNumber,
    title: sourceRevision.title,
    summary: sourceRevision.summary,
    categoryId: sourceRevision.categoryId,
    tags: [...sourceRevision.tags],
    body: sourceRevision.body,
    editorId: actorId,
    changeSummary: `Restored from revision ${revisionNumber}`,
    restoredFromRevisionNumber: revisionNumber,
  });

  const updated = await updateArticleContent(workspaceId, selfId, {
    title: sourceRevision.title,
    summary: sourceRevision.summary,
    body: sourceRevision.body,
    categoryId: sourceRevision.categoryId,
    tags: [...sourceRevision.tags],
    lastEditedById: actorId,
  });
  if (updated === null) {
    logger.error(
      { workspaceId: workspaceId.toHexString(), articleId: selfId.toHexString(), revisionNumber: newNumber },
      'KB revision restore applied the snapshot but lost the article update',
    );
    throw new AppError('Article restore failed after revision persistence', {
      statusCode: 500,
      code: 'KB_RESTORE_FAILED',
      isOperational: false,
    });
  }

  recordKbAudit({
    action: KB_AUDIT_ACTIONS.revisionRestored,
    workspaceId,
    actorId,
    resourceType: KB_RESOURCE_TYPES.revision,
    resourceId: revision._id.toHexString(),
    metadata: {
      restoredFromRevisionNumber: revisionNumber,
      newRevisionNumber: newNumber,
      articleId: selfId.toHexString(),
    },
  });

  // A revision restore rewrites the CURRENT content of the article — the RAG
  // projection follows it when the article is live-published (fire-safe).
  if (updated.status === 'PUBLISHED') {
    scheduleArticleChunkIndexing(workspaceId.toHexString(), selfId.toHexString());
  }

  return { revision: toRevisionDto(revision) };
}
