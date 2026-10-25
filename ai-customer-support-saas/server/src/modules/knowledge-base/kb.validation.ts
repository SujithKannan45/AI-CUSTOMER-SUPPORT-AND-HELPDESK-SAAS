import { z } from 'zod';

import {
  KB_BODY_MAX,
  KB_CHANGE_SUMMARY_MAX,
  KB_SLUG_MAX,
  KB_SUMMARY_MAX,
  KB_TITLE_MAX,
  MAX_KB_TAGS,
  KB_TAG_MAX_LENGTH,
} from './kb.types.js';

/**
 * Knowledge Base request validation (Zod, applied declaratively at the
 * routes) — mirroring the models so HTTP failures are 422s and anything that
 * slips past is still caught at the schema boundary (same two-layer contract
 * as conversation.validation.ts).
 *
 * Mass-assignment protection: every schema is `.strict()` and defines ONLY
 * the accepted keys. Fields that could corrupt tenant identity, lifecycle or
 * history are STRUCTURALLY unacceptable:
 * - the client can NEVER supply `workspaceId`, `createdById`,
 *   `lastEditedById`, `editorId`, `currentRevisionNumber` or `revisionNumber`
 *   — identity and revision numbering are composed server-side;
 * - `status`, `publishedAt`, `archivedAt` are driven ONLY through the
 *   lifecycle action endpoints (publish/unpublish/archive/restore), never
 *   through create/update payloads;
 * - revision numbers arrive only as route params.
 */
export const MAX_KB_PAGE_SIZE = 50;
export const MAX_KB_SEARCH_LENGTH = 100;

export const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-f\d]{24}$/i, 'Must be a 24-character hex string');

// ── Identification ───────────────────────────────────────────────────────────

export const kbCategoryParamSchema = z
  .object({
    workspaceId: objectIdSchema,
    categoryId: objectIdSchema,
  })
  .strict();

export interface KbCategoryParams {
  workspaceId: string;
  categoryId: string;
}

export const kbArticleParamSchema = z
  .object({
    workspaceId: workspaceIdFields(),
    articleId: objectIdSchema,
  })
  .strict();

export interface KbArticleParams {
  workspaceId: string;
  articleId: string;
}

function workspaceIdFields(): z.ZodString {
  return objectIdSchema;
}

export const kbRevisionParamSchema = z
  .object({
    workspaceId: workspaceIdFields(),
    articleId: objectIdSchema,
    revisionNumber: z.coerce.number().int().min(1),
  })
  .strict();

export interface KbRevisionParams {
  workspaceId: string;
  articleId: string;
  revisionNumber: number;
}

// ── Pagination (shared contract with the other modules) ─────────────────────

export const kbPaginationSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z
      .coerce
      .number()
      .int()
      .min(1)
      .max(MAX_KB_PAGE_SIZE, `Page size must be at most ${MAX_KB_PAGE_SIZE}`)
      .default(20),
  })
  .strict();

export interface KbPagination {
  page: number;
  limit: number;
}

// ── Categories ───────────────────────────────────────────────────────────────

const categoryNameSchema = z
  .string()
  .trim()
  .min(1, 'Category name is required')
  .max(100, 'Category name must be at most 100 characters');

const kbDisplayOrderSchema = z
  .number()
  .int('Display order must be an integer')
  .min(0)
  .max(10_000);

export const createCategorySchema = z
  .object({
    name: categoryNameSchema,
    description: z.string().trim().max(500).optional(),
    parentId: objectIdSchema.nullish(),
    displayOrder: kbDisplayOrderSchema.optional(),
  })
  .strict();

export interface CreateCategoryInput {
  name: string;
  description?: string;
  parentId?: string | null;
  displayOrder?: number;
}

/**
 * Update policy: name re-derives the slug (slug is NEVER a client field),
 * description/displayOrder/parentId are optional and nullable. Lifecycle
 * moves run through the archive/restore action endpoints only.
 */
export const updateCategorySchema = z
  .object({
    name: categoryNameSchema.optional(),
    description: z.string().trim().max(500).nullable().optional(),
    parentId: objectIdSchema.nullish(),
    displayOrder: kbDisplayOrderSchema.optional(),
  })
  .strict();

export interface UpdateCategoryInput {
  name?: string;
  description?: string | null;
  parentId?: string | null;
  displayOrder?: number;
}

export const listCategoriesQuerySchema = kbPaginationSchema;

// ── Articles ─────────────────────────────────────────────────────────────────

/**
 * Article slug: optional at create (auto-derived from the title when
 * absent) — normalized + validated by the SERVICE with the platform slug
 * helpers (workspaces/slug.ts); the Zod layer only bounds the shape here.
 * Never accepted for categories (their slug is always name-derived).
 */
const articleSlugSchema = z.string().trim().max(KB_SLUG_MAX).optional();

const articleTagsSchema = z.array(
  z.string().trim().min(1).max(KB_TAG_MAX_LENGTH),
).max(MAX_KB_TAGS).default([]);

const articleBodySchema = z
  .string()
  .max(KB_BODY_MAX, `Article body must be at most ${KB_BODY_MAX} characters`)
  .refine((body) => body.trim().length > 0, 'Article body is required');

export const createArticleSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, 'Article title is required')
      .max(KB_TITLE_MAX, `Article title must be at most ${KB_TITLE_MAX} characters`),
    slug: articleSlugSchema,
    summary: z.string().trim().max(KB_SUMMARY_MAX).optional(),
    body: articleBodySchema,
    tags: articleTagsSchema,
    categoryId: objectIdSchema.nullish(),
  })
  .strict();

export interface CreateArticleInput {
  title: string;
  slug?: string;
  summary?: string;
  body: string;
  tags?: string[];
  categoryId?: string | null;
}

/**
 * Update policy: content fields are optional; `changeSummary` labels the
 * revision the edit will produce (recorded on the snapshot, never on the
 * article document). Empty request = a no-op (200, no revision).
 */
export const updateArticleSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, 'Article title is required')
      .max(KB_TITLE_MAX, `Article title must be at most ${KB_TITLE_MAX} characters`)
      .optional(),
    slug: articleSlugSchema,
    summary: z.string().trim().max(KB_SUMMARY_MAX).nullable().optional(),
    body: articleBodySchema.optional(),
    tags: articleTagsSchema.optional(),
    categoryId: objectIdSchema.nullish(),
    changeSummary: z.string().trim().max(KB_CHANGE_SUMMARY_MAX).optional(),
  })
  .strict();

export interface UpdateArticleInput {
  title?: string;
  slug?: string;
  summary?: string | null;
  body?: string;
  tags?: string[];
  categoryId?: string | null;
  changeSummary?: string;
}

/** Lifecycle action endpoints accept NO body — statuses are server-decided. */
export const kbLifecycleSchema = z.object({}).strict();

export const listArticlesQuerySchema = kbPaginationSchema
  .extend({
    search: z.string().trim().max(MAX_KB_SEARCH_LENGTH).optional(),
    categoryId: objectIdSchema.optional(),
    tags: z
      .string()
      .max(1_000)
      .optional()
      .refine(
        (value) => {
          if (value === undefined || value === '') return true;
          const tags = value.split(',').map((t) => t.trim()).filter(Boolean);
          return tags.length <= MAX_KB_TAGS && tags.every((t) => t.length <= KB_TAG_MAX_LENGTH);
        },
        `At most ${MAX_KB_TAGS} tags of ${KB_TAG_MAX_LENGTH} characters each`,
      ),
    status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
    authorId: objectIdSchema.optional(),
    createdFrom: z.coerce.date().optional(),
    createdTo: z.coerce.date().optional(),
    updatedFrom: z.coerce.date().optional(),
    updatedTo: z.coerce.date().optional(),
    sort: z.enum(['title', 'createdAt', 'updatedAt', 'publishedAt']).optional(),
    order: z.enum(['asc', 'desc']).optional(),
  })
  .strict();

export type ListArticlesQuery = z.infer<typeof listArticlesQuerySchema>;

export const listRevisionsQuerySchema = kbPaginationSchema;

// ── Public read layer (anonymous) ─────────────────────────────────────────

/** Workspace slug shape mirrors the platform slug law (3–63, URL-safe). */
export const publicWorkspaceParamSchema = z
  .object({
    workspaceSlug: z
      .string()
      .trim()
      .toLowerCase()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Must be a lowercase URL-safe workspace slug'),
  })
  .strict();

export interface PublicWorkspaceParams {
  workspaceSlug: string;
}

export const publicArticleParamSchema = publicWorkspaceParamSchema
  .extend({
    articleSlug: z
      .string()
      .trim()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Must be a lowercase URL-safe article slug'),
  })
  .strict();

export interface PublicArticleParams {
  workspaceSlug: string;
  articleSlug: string;
}

/**
 * The public list query deliberately has NO status field: published-only is
 * composed server-side (kb-public.service.ts), never a client choice.
 */
export const publicListArticlesQuerySchema = kbPaginationSchema
  .extend({
    categoryId: objectIdSchema.optional(),
    search: z.string().trim().max(MAX_KB_SEARCH_LENGTH).optional(),
  })
  .strict();

export type PublicListArticlesQuery = z.infer<typeof publicListArticlesQuerySchema>;

/**
 * Documentation only (identity fields are rejected by the strict schemas): the
 * fields that can NEVER be accepted from a request payload — mirrors the
 * conversation module's reviewer checklist.
 */
export const NON_CLIENT_FIELDS = [
  'workspaceId',
  'createdById',
  'lastEditedById',
  'editorId',
  'status',
  'publishedAt',
  'archivedAt',
  'currentRevisionNumber',
  'revisionNumber',
] as const;
