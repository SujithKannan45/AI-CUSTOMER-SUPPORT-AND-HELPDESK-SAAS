import { z } from 'zod';

import { RAG_CHUNK_SOURCE_TYPES, RAG_EMBEDDING_STATUSES } from './rag.types.js';

/**
 * RAG API validation — every route parameter and query field is a bounded,
 * allowlisted Zod schema (same conventions as kb.validation.ts). No raw
 * objects ever flow toward Mongo.
 */

const MAX_RAG_PAGE_SIZE = 50;

const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Must be a 24-hex-character ObjectId');

export const ragSourceParamSchema = z.object({
  workspaceId: objectIdSchema,
});

export const ragSourceParamsSchema = z
  .object({
    workspaceId: objectIdSchema,
    fileId: objectIdSchema,
  })
  .strict();
export interface RagSourceParams {
  readonly workspaceId: string;
  readonly fileId: string;
}

export const ragArticleParamsSchema = z
  .object({
    workspaceId: objectIdSchema,
    articleId: objectIdSchema,
  })
  .strict();
export interface RagArticleParams {
  readonly workspaceId: string;
  readonly articleId: string;
}

export const ragPurgeParamsSchema = z
  .object({
    workspaceId: objectIdSchema,
    sourceType: z.enum(RAG_CHUNK_SOURCE_TYPES),
    sourceId: objectIdSchema,
  })
  .strict();
export interface RagPurgeParams {
  readonly workspaceId: string;
  readonly sourceType: (typeof RAG_CHUNK_SOURCE_TYPES)[number];
  readonly sourceId: string;
}

export const ragChunksQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(MAX_RAG_PAGE_SIZE).default(20),
    sourceType: z.enum(RAG_CHUNK_SOURCE_TYPES).optional(),
    sourceId: objectIdSchema.optional(),
    embeddingStatus: z.enum(RAG_EMBEDDING_STATUSES).optional(),
  })
  .strict();
export interface RagChunksQuery {
  readonly page: number;
  readonly limit: number;
  readonly sourceType?: (typeof RAG_CHUNK_SOURCE_TYPES)[number];
  readonly sourceId?: string;
  readonly embeddingStatus?: (typeof RAG_EMBEDDING_STATUSES)[number];
}
