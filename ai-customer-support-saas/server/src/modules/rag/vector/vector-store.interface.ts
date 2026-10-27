import { type Types, type ClientSession } from 'mongoose';

import type { RagChunkSourceType } from '../rag.types.js';

/**
 * Vector-store abstraction (Prompt 13) — separates storage-retrieval from
 * embedding generation: a store consumes PRE-EMBEDDED query vectors and
 * returns passages with similarity scores + source traceability.
 *
 * Isolation law: every implementation MUST apply the workspace scope AND the
 * eligibility predicate (sourceEligible + embedding COMPLETED + matching
 * dimensionality) INSIDE the query — never as a post-filter on returned
 * results — so a compromised or mis-configured store cannot hand back other
 * tenants' vectors.
 */
export interface VectorSearchInput {
  readonly workspaceId: Types.ObjectId;
  /** Query vector produced by the configured EmbeddingProvider. */
  readonly queryVector: readonly number[];
  /** 1..RAG_MAX_RETRIEVE_LIMIT (validated upstream). */
  readonly limit: number;
  /** Similarity floor applied AFTER scoring; 0 disables. */
  readonly minScore?: number;
}

export interface VectorMatch {
  readonly chunkId: string;
  readonly sourceType: RagChunkSourceType;
  readonly sourceId: string;
  readonly text: string;
  readonly score: number;
}

/**
 * @param session — OPTIONAL Mongoose session passthrough (maintained for
 * future transaction parity; the current deployment runs without them).
 */
export interface VectorStore {
  readonly name: 'atlas' | 'inmemory';
  searchByVector(
    input: VectorSearchInput,
    session?: ClientSession,
  ): Promise<readonly VectorMatch[]>;
}

/** Codes a store surfaces (safe, mapped to 503 by the retrieval service). */
export const VECTOR_STORE_ERROR_CODE = 'RAG_VECTOR_SEARCH_FAILED' as const;
