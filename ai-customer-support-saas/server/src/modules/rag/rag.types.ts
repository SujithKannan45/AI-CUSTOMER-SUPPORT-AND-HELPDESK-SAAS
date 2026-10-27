import type { Types } from 'mongoose';

import type { TenantScopedDocument } from '../../database/tenant.js';

/**
 * RAG foundation domain vocabulary (Prompt 13) — the domain contract;
 * rag.model.ts is the persistence boundary. Same split as document.types.ts.
 *
 * Design center: chunks are the AI-retrieval projection of ELIGIBLE sources —
 * published Knowledge Base articles and Prompt 12 documents whose extraction
 * COMPLETED. Chunks never exist for draft, archived, failed or deleted
 * content: the `sourceEligible` flag plus the indexing lifecycle keeps the
 * projection honest, and retrieval filters on it INSIDE the store query.
 */

/** Which kind of source a chunk was derived from. */
export const RAG_CHUNK_SOURCE_TYPES = ['KB_ARTICLE', 'DOCUMENT'] as const;
export type RagChunkSourceType = (typeof RAG_CHUNK_SOURCE_TYPES)[number];

/** Per-chunk embedding sub-state (chunks whose text is stored but vectors failed). */
export const RAG_EMBEDDING_STATUSES = ['PENDING', 'COMPLETED', 'FAILED'] as const;
export type RagEmbeddingStatus = (typeof RAG_EMBEDDING_STATUSES)[number];

/** Safe, user-displayable provider failure — no stack traces or file content. */
export interface RagEmbeddingError {
  readonly code: string;
  readonly message: string;
}

/**
 * RagChunk — one retrieval passage derived from a workspace-owned source.
 *
 * Tenant-scoped like every other collection (`TenantScopedDocument`):
 * - the UNIQUE `{ workspaceId, sourceType, sourceId, chunkIndex }` index is
 *   the reindex idempotency LAW (an upsert race can never duplicate a chunk);
 * - `textHash` (sha-256 of the normalized chunk text) lets reindexes reuse an
 *   existing embedding instead of re-embedding unchanged content;
 * - `sourceHash` (sha-256 of the normalized SOURCE text) lets a reindex
 *   detect "nothing changed" and skip the whole write;
 * - `embedding`/`embeddingModel`/`embeddingDimensions` record exactly which
 *   representation was produced so a changed configuration cannot silently
 *   mix vectors from different spaces (dimension is validated per query);
 * - `sourceEligible` is denormalized from the source state and maintained by
 *   the indexing lifecycle, so retrieval can prefilter vectors WITHOUT
 *   joining back to the source document.
 */
export interface RagChunkDocument extends TenantScopedDocument {
  sourceType: RagChunkSourceType;
  sourceId: Types.ObjectId;
  /** 0-based position of this passage within the source (stable input order). */
  chunkIndex: number;
  /** Normalized chunk text — the passage future retrieval/prompting consumes. */
  text: string;
  textLength: number;
  /** sha-256 hex of `text` (chunk-level dedupe key). */
  textHash: string;
  /** sha-256 hex of the normalized source text this chunk belongs to. */
  sourceHash: string;
  embeddingStatus: RagEmbeddingStatus;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  embeddingError: RagEmbeddingError | null;
  embedding: number[] | null;
  sourceEligible: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Result statuses of an indexing run over one source document. */
export const RAG_INDEX_OUTCOMES = ['INDEXED', 'UNCHANGED', 'SKIPPED'] as const;
export type RagIndexOutcome = (typeof RAG_INDEX_OUTCOMES)[number];

/** Stable machine reasons for a SKIPPED run (safe to surface to callers). */
export type RagSkipReason =
  | 'EMPTY_CONTENT'
  | 'SOURCE_TOO_LARGE'
  | 'ARTICLE_NOT_PUBLISHED'
  | 'EXTRACTED_TEXT_UNAVAILABLE';

export interface RagIndexResult {
  readonly outcome: RagIndexOutcome;
  /** Present (and safe) whenever `outcome` = 'SKIPPED'. */
  readonly skipReason?: RagSkipReason;
  readonly chunksIndexed: number;
  /** Chunks whose stored text was unchanged — embedding reused, no provider call. */
  readonly chunksReused: number;
  /** Obsolete chunks (dead chunk indexes) removed by this run. */
  readonly chunksRemoved: number;
  /** Chunks that reached a terminal FAILED embedding state during this run. */
  readonly embeddingFailures: number;
}

/** One retrieval passage: text + similarity signal + source traceability. */
export interface RagPassage {
  readonly chunkId: string;
  readonly sourceType: RagChunkSourceType;
  readonly sourceId: string;
  readonly text: string;
  /** Similarity score (cosine similarity rank; provider/search-score semantics per store). */
  readonly score: number;
}
