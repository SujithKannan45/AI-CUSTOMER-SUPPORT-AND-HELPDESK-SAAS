import type { Types } from 'mongoose';

import type { WorkspaceRole } from '../workspaces/workspace.types.js';

import type {
  KbArticleDocument,
  KbArticleStatus,
  KbCategoryDocument,
  KbRevisionDocument,
} from './kb.types.js';

/**
 * Knowledge Base module — public DTOs, service payloads and query objects
 * (the same split ticket.dto.ts / conversation.dto.ts established). The safe
 * representation that crosses the HTTP boundary lives here — never the raw
 * Mongoose document.
 *
 * No user/workspace population: author/editor/category references stay ids;
 * consumers resolve names through their own modules.
 */

// ── Shared request context ───────────────────────────────────────────────────

/**
 * Middleware-validated actor context (identical contract to
 * ConversationRequestContext): ids come from `req.workspace`/`req.auth` —
 * never from request payloads.
 */
export interface KbRequestContext {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly role: WorkspaceRole;
}

// ── Categories (management) ──────────────────────────────────────────────────

export interface KbCategoryDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly displayOrder: number;
  readonly archived: boolean;
  readonly createdById: string;
  readonly updatedById: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── Articles (management) ────────────────────────────────────────────────────

export interface KbArticleSummaryDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly categoryId: string | null;
  readonly title: string;
  readonly slug: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly status: KbArticleStatus;
  readonly currentRevisionNumber: number;
  readonly publishedAt: string | null;
  readonly archivedAt: string | null;
  readonly createdById: string;
  readonly lastEditedById: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Detail adds the stored Markdown body — list responses never carry it. */
export interface KbArticleDto extends KbArticleSummaryDto {
  readonly body: string;
}

// ── Revisions (management) ───────────────────────────────────────────────────

export interface KbRevisionSummaryDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly articleId: string;
  readonly revisionNumber: number;
  readonly title: string;
  readonly summary: string;
  readonly categoryId: string | null;
  readonly tags: readonly string[];
  readonly editorId: string;
  readonly changeSummary: string | null;
  readonly restoredFromRevisionNumber: number | null;
  readonly createdAt: string;
}

/** Single-revision reads add the snapshot body. */
export interface KbRevisionDto extends KbRevisionSummaryDto {
  readonly body: string;
}

// ── Public read models (customer-facing — explicitly permitted fields only) ──

/**
 * The public contract contains NO management state: no status flag, no
 * author/editor ids, no revision pointers, no draft/archived timestamps.
 * `publishedAt` is the one lifecycle stamp retained (freshness signal).
 */
export interface PublicKbCategoryDto {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly parentId: string | null;
  readonly displayOrder: number;
}

export interface PublicKbArticleSummaryDto {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly categoryId: string | null;
  readonly publishedAt: string;
  readonly updatedAt: string;
}

/** Detail adds the Markdown body (safe-rendering contract in kb.types.ts). */
export interface PublicKbArticleDto extends PublicKbArticleSummaryDto {
  readonly body: string;
}

// ── Service payload types (controller envelope data) ─────────────────────────

export interface KbCategoryDetailPayload {
  readonly category: KbCategoryDto;
}

export interface KbCategoryListPayload {
  readonly items: readonly KbCategoryDto[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMore: boolean;
}

export interface KbArticleCreatedPayload {
  readonly article: KbArticleDto;
}

export interface KbArticleDetailPayload {
  readonly article: KbArticleDto;
}

export interface KbArticleListPayload {
  readonly items: readonly KbArticleSummaryDto[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMore: boolean;
}

export interface KbRevisionListPayload {
  readonly items: readonly KbRevisionSummaryDto[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMore: boolean;
}

export interface KbRevisionDetailPayload {
  readonly revision: KbRevisionDto;
}

export interface PublicKbCategoryListPayload {
  readonly items: readonly PublicKbCategoryDto[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMore: boolean;
}

export interface PublicKbArticleListPayload {
  readonly items: readonly PublicKbArticleSummaryDto[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMore: boolean;
}

export interface PublicKbArticleDetailPayload {
  readonly article: PublicKbArticleDto;
}

// ── Mappers (the single place a document becomes a DTO) ──────────────────────

export function toCategoryDto(doc: KbCategoryDocument): KbCategoryDto {
  return {
    id: doc._id.toHexString(),
    workspaceId: doc.workspaceId.toHexString(),
    parentId: doc.parentId === null ? null : doc.parentId.toHexString(),
    name: doc.name,
    slug: doc.slug,
    description: doc.description?.length ? doc.description : null,
    displayOrder: doc.displayOrder,
    archived: doc.archivedAt !== null,
    createdById: doc.createdById.toHexString(),
    updatedById: doc.updatedById.toHexString(),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function toArticleSummaryDto(doc: KbArticleDocument): KbArticleSummaryDto {
  return {
    id: doc._id.toHexString(),
    workspaceId: doc.workspaceId.toHexString(),
    categoryId: doc.categoryId === null ? null : doc.categoryId.toHexString(),
    title: doc.title,
    slug: doc.slug,
    summary: doc.summary,
    tags: [...doc.tags],
    status: doc.status,
    currentRevisionNumber: doc.currentRevisionNumber,
    publishedAt: doc.publishedAt?.toISOString() ?? null,
    archivedAt: doc.archivedAt?.toISOString() ?? null,
    createdById: doc.createdById.toHexString(),
    lastEditedById: doc.lastEditedById.toHexString(),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function toArticleDto(doc: KbArticleDocument): KbArticleDto {
  return { ...toArticleSummaryDto(doc), body: doc.body };
}

export function toRevisionSummaryDto(doc: KbRevisionDocument): KbRevisionSummaryDto {
  return {
    id: doc._id.toHexString(),
    workspaceId: doc.workspaceId.toHexString(),
    articleId: doc.articleId.toHexString(),
    revisionNumber: doc.revisionNumber,
    title: doc.title,
    summary: doc.summary,
    categoryId: doc.categoryId === null ? null : doc.categoryId.toHexString(),
    tags: [...doc.tags],
    editorId: doc.editorId.toHexString(),
    changeSummary: doc.changeSummary?.length ? doc.changeSummary : null,
    restoredFromRevisionNumber: doc.restoredFromRevisionNumber,
    createdAt: doc.createdAt.toISOString(),
  };
}

export function toRevisionDto(doc: KbRevisionDocument): KbRevisionDto {
  return { ...toRevisionSummaryDto(doc), body: doc.body };
}

export function toPublicCategoryDto(doc: KbCategoryDocument): PublicKbCategoryDto {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    slug: doc.slug,
    description: doc.description?.length ? doc.description : null,
    parentId: doc.parentId === null ? null : doc.parentId.toHexString(),
    displayOrder: doc.displayOrder,
  };
}

export function toPublicArticleSummaryDto(doc: KbArticleDocument): PublicKbArticleSummaryDto {
  return {
    id: doc._id.toHexString(),
    title: doc.title,
    slug: doc.slug,
    summary: doc.summary,
    tags: [...doc.tags],
    categoryId: doc.categoryId === null ? null : doc.categoryId.toHexString(),
    publishedAt: doc.publishedAt instanceof Date ? doc.publishedAt.toISOString() : '',
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function toPublicArticleDto(doc: KbArticleDocument): PublicKbArticleDto {
  return { ...toPublicArticleSummaryDto(doc), body: doc.body };
}

// ── Service → repository query objects (already validated) ───────────────────

export interface KbCategoryListSpec {
  readonly workspaceId: Types.ObjectId;
  readonly page: number;
  readonly limit: number;
}

export interface KbArticleFilterSpec {
  readonly workspaceId: Types.ObjectId;
  readonly page: number;
  readonly limit: number;
  readonly search?: string;
  readonly categoryId?: string;
  readonly tags?: string[];
  readonly status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  readonly authorId?: string;
  readonly createdFrom?: Date;
  readonly createdTo?: Date;
  readonly updatedFrom?: Date;
  readonly updatedTo?: Date;
  readonly sort?: 'title' | 'createdAt' | 'updatedAt' | 'publishedAt';
  readonly order?: 'asc' | 'desc';
}
