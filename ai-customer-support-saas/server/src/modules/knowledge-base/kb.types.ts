import type { Types } from 'mongoose';

import type { TenantScopedDocument } from '../../database/tenant.js';

/**
 * Knowledge Base domain vocabulary — article/categories/revision shapes are
 * declared here (same split ticket.types.ts / conversation.types.ts follow:
 * THIS file is the domain contract, kb.model.ts is the persistence boundary).
 */

/**
 * Article lifecycle inside a workspace. Exactly three states:
 *
 *   DRAFT ──publish──▶ PUBLISHED ──unpublish──▶ DRAFT
 *     │                    │
 *     └──archive───────────┴──archive──▶ ARCHIVED ──restore──▶ DRAFT
 *
 * - ARCHIVED is a first-CLASS status, not a soft delete: archived articles
 *   keep their content and revision history and return to DRAFT on restore.
 *   There is no hidden deletedAt hook for articles (unlike customers/tickets
 *   and KB categories): every article read composes its status filter
 *   EXPLICITLY, so draft content landing in a wrong audience is always a
 *   visible query decision, never an implicit default.
 * - Public (customer-facing) reads see PUBLISHED ONLY — enforced structurally
 *   by kb-public.service.ts, never by a client-supplied filter.
 */
export const KB_ARTICLE_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type KbArticleStatus = (typeof KB_ARTICLE_STATUSES)[number];

/** Allowed lifecycle actions: what state each action may START from. */
export const KB_ARTICLE_TRANSITIONS: Record<
  'publish' | 'unpublish' | 'archive' | 'restore',
  { readonly from: readonly KbArticleStatus[]; readonly to: KbArticleStatus }
> = {
  publish: { from: ['DRAFT'], to: 'PUBLISHED' },
  unpublish: { from: ['PUBLISHED'], to: 'DRAFT' },
  archive: { from: ['DRAFT', 'PUBLISHED'], to: 'ARCHIVED' },
  restore: { from: ['ARCHIVED'], to: 'DRAFT' },
};

/**
 * Verification/preview promise for future consumers: the CURRENT-published
 * set is `{ status: 'PUBLISHED' }` — retrievable per workspace independently
 * (AI/RAG ingestion in Prompts 13–15 consumes exactly this predicate; no
 * derived fields or embeddings live on the article model by design).
 */
export const KB_PUBLISHED_FILTER = { status: 'PUBLISHED' } as const;

// ── Content bounds (shared by kb.model.ts and kb.validation.ts) ──────────────

export const KB_TITLE_MAX = 200;
export const KB_SLUG_MAX = 63; // Same platform slug budget as workspace slugs.
export const KB_SUMMARY_MAX = 500;
/** Bounded so a document stays well under the 16 MiB BSON ceiling. */
export const KB_BODY_MAX = 50_000;
export const KB_CHANGE_SUMMARY_MAX = 300;
export const MAX_KB_TAGS = 20;
export const KB_TAG_MAX_LENGTH = 40;
export const KB_DESCRIPTION_MAX = 500;
export const KB_DISPLAY_ORDER_MAX = 10_000;
/** Maximum category nesting depth (root = level 1). */
export const MAX_KB_CATEGORY_DEPTH = 5;
/** Bounded auto-slug retry budget for article creation (see kb.service). */
export const KB_SLUG_AUTO_RETRY_LIMIT = 25;

/**
 * Allowed category display-order range. Race-safe reordering via unique
 * swap is intentionally NOT implemented (workspaces reorder dozens, not
 * millions, of categories); stale gte/lte validation is a documented limit.
 */
export const KB_DISPLAY_ORDER_MIN = 0;

// ── Documents ────────────────────────────────────────────────────────────────

/**
 * KnowledgeBaseCategory — one node in a workspace's KB folder tree.
 * Strictly tenant-scoped; `slug` is DERIVED from `name` by the service
 * (never client-supplied), so name uniqueness and slug uniqueness are one
 * law enforced by the `uniq_kb_category_slug_per_workspace` index.
 */
export interface KbCategoryDocument extends TenantScopedDocument {
  name: string;
  slug: string;
  description: string | null;
  /** Parent category (same workspace); null = a root category. */
  parentId: Types.ObjectId | null;
  /** UI ordering weight among siblings; ascending. */
  displayOrder: number;
  /** Set when the category is archived, cleared on restore. */
  archivedAt: Date | null;
  createdById: Types.ObjectId;
  updatedById: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * KnowledgeBaseArticle — one support article inside a workspace.
 *
 * Content NORMALIZATION/representation for Prompt 11 and future AI/RAG:
 * - `body` is MARKDOWN/plain-text SOURCE stored verbatim (bounded by
 *   KB_BODY_MAX). No HTML is ever stored or rendered server-side. The
 *   rendering contract for frontend consumers: render via a Markdown
 *   renderer with raw HTML disabled or sanitized (e.g. marked + DOMPurify
 *   with the default no-raw-HTML configuration); the API never returns
 *   HTML. Stored-XSS is contractually prevented by keeping content inert.
 * - `title`, `summary`, `body` are clean, retrievable, per-workspace fields
 *   for future embedding pipelines (Prompts 13–15). No embeddings, vectors
 *   or chunk metadata are stored on articles.
 * - `currentRevisionNumber` points at the newest snapshot in the revisions
 *   collection (kb-article.repository.ts); the id-links (NOT the bodies)
 *   are duplicated here.
 * - `scheduledFor` was considered and DELIBERATELY omitted: the platform
 *   has no scheduler/cron infrastructure yet, so a scheduled-publish field
 *   could silently strand drafts. Publish remains an explicit action.
 */
export interface KbArticleDocument extends TenantScopedDocument {
  categoryId: Types.ObjectId | null;
  title: string;
  slug: string;
  summary: string;
  body: string;
  tags: string[];
  status: KbArticleStatus;
  /** Newest revision number (1 = initial creation snapshot). */
  currentRevisionNumber: number;
  /** Set when entering PUBLISHED, cleared on unpublish/restore. */
  publishedAt: Date | null;
  /** Set when entering ARCHIVED, cleared on restore. */
  archivedAt: Date | null;
  createdById: Types.ObjectId;
  /** Who wrote the STORED CONTENT last (not lifecycle actions like publish). */
  lastEditedById: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * KnowledgeBaseArticleRevision — immutable, bounded snapshot of one article
 * version. Append-only (model-enforced, mirroring AuditLog immutability);
 * restoring an old revision CREATES a NEW newest revision — history
 * never rewritten, never deleted.
 */
export interface KbRevisionDocument extends TenantScopedDocument {
  articleId: Types.ObjectId;
  /** 1..N unique per (workspace, article); allocated server-side ONLY. */
  revisionNumber: number;
  title: string;
  summary: string;
  categoryId: Types.ObjectId | null;
  tags: string[];
  body: string;
  /** Member who authored this version. */
  editorId: Types.ObjectId;
  /** Optional user-supplied context for content edits; fixed text on restores. */
  changeSummary: string | null;
  /** Set when this revision was produced by restoring an older one. */
  restoredFromRevisionNumber: number | null;
  createdAt: Date;
}
