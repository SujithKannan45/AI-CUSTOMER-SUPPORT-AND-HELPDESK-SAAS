import type { Types } from 'mongoose';

import { AppError } from '../../core/errors/app-error.js';
import { findWorkspaceBySlug } from '../workspaces/workspace.repository.js';

import { findPublishedArticleBySlug, listArticles } from './kb-article.repository.js';
import { listCategories } from './kb-category.repository.js';
import {
  toPublicArticleDto,
  toPublicArticleSummaryDto,
  toPublicCategoryDto,
  type PublicKbArticleDetailPayload,
  type PublicKbArticleListPayload,
  type PublicKbCategoryListPayload,
} from './kb.dto.js';

/**
 * Public Knowledge Base read service — the SAFE, SEPARATED read-only layer
 * for the future customer-facing KB (Prompt 19+ owns the frontend; this
 * backend layer is the contract it will consume).
 *
 * Safety laws (structurally impossible to violate):
 * - NOTHING requires a customer identity (none exists in this codebase yet —
 *   the same documented dependency as Prompt 9): the workspace SLUG is the
 *   tenant selector, validated against the `uniq_workspace_slug`-backed
 *   workspace repository. Unknown slugs, archived workspaces and lookup
 *   misses are one indistinguishable 404.
 * - ONLY `{ status: 'PUBLISHED' }` documents are ever reachable: the filter
 *   is composed INSIDE this service (and in findPublishedArticleBySlug) and
 *   is NOT a client-supplied field — the public query schemas have no status
 *   key at all. Drafts, archived articles, revision history and management
 *   fields are unreachable by construction.
 * - Response shapes use the public DTO mappers explicitly: no status flag,
 *   no author/editor ids, no revision counters, no archived timestamps.
 * - NO audit logging for anonymous reads (see kb-audit.ts) — abusive request
 *   volume must not flood the compliance trail; the dedicated rate limiter
 *   on the public router is the protection layer.
 * - Pagination and search are bounded and validated by Zod; search uses the
 *   same tenant-slice case-insensitive scan as management reads (documented
 *   in kb-article.repository.ts — the future AI retrieval phase supersedes
 *   it; no external search service was introduced).
 */

const KB_NOT_FOUND = 'Knowledge base not found';
const ARTICLE_NOT_FOUND = 'Article not found';

/** Resolves a believed-public workspace slug to a tenant id, or 404s. */
export async function resolvePublicWorkspace(workspaceSlug: string): Promise<{
  readonly workspaceId: Types.ObjectId;
}> {
  const workspace = await findWorkspaceBySlug(workspaceSlug.toLowerCase());
  if (workspace === null || workspace.status !== 'active') {
    throw AppError.notFound(KB_NOT_FOUND);
  }
  return { workspaceId: workspace._id };
}

export async function publicListCategoriesFlow(
  workspaceSlug: string,
  query: { readonly page: number; readonly limit: number },
): Promise<PublicKbCategoryListPayload> {
  const { workspaceId } = await resolvePublicWorkspace(workspaceSlug);
  // The same query object serves management and public reads; the PUBLIC
  // shape is applied by the DTO mapper, not by column filtering here.
  const result = await listCategories({ workspaceId, page: query.page, limit: query.limit });

  return {
    items: result.items.map((doc) => toPublicCategoryDto(doc)),
    page: query.page,
    limit: query.limit,
    total: result.total,
    hasMore: result.hasMore,
  };
}

export async function publicListArticlesFlow(
  workspaceSlug: string,
  query: {
    readonly page: number;
    readonly limit: number;
    readonly categoryId?: string;
    readonly search?: string;
  },
): Promise<PublicKbArticleListPayload> {
  const { workspaceId } = await resolvePublicWorkspace(workspaceSlug);

  const result = await listArticles({
    workspaceId,
    page: query.page,
    limit: query.limit,
    status: 'PUBLISHED', // Composed HERE, never accepted from clients.
    sort: 'publishedAt',
    order: 'desc',
    ...(query.categoryId !== undefined ? { categoryId: query.categoryId } : {}),
    ...(query.search !== undefined && query.search !== '' ? { search: query.search } : {}),
  });

  return {
    items: result.items.map((doc) => toPublicArticleSummaryDto(doc)),
    page: query.page,
    limit: query.limit,
    total: result.total,
    hasMore: result.hasMore,
  };
}

export async function publicGetArticleFlow(
  workspaceSlug: string,
  articleSlug: string,
): Promise<PublicKbArticleDetailPayload> {
  const { workspaceId } = await resolvePublicWorkspace(workspaceSlug);

  const article = await findPublishedArticleBySlug(workspaceId, articleSlug);
  if (article === null) throw AppError.notFound(ARTICLE_NOT_FOUND);
  return { article: toPublicArticleDto(article) };
}
