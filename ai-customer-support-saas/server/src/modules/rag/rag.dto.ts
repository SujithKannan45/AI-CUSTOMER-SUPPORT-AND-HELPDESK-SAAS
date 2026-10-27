import type { RagStatusReport } from './rag-status.service.js';
import { type RagChunkDocument ,type 
  RagChunkSourceType,type 
  RagEmbeddingStatus,type 
  RagIndexResult,
} from './rag.types.js';

/**
 * HTTP contracts for the RAG management endpoints. Listings deliberately
 * OMIT chunk text and embedding vectors (internal pipeline content): counts,
 * hashes, statuses and source references only. Passage text flows through
 * the retrieval SERVICE, not through these payloads.
 */
export interface RagChunkDto {
  readonly id: string;
  readonly sourceType: RagChunkSourceType;
  readonly sourceId: string;
  readonly chunkIndex: number;
  readonly textLength: number;
  readonly textHash: string;
  readonly sourceHash: string;
  readonly embeddingStatus: RagEmbeddingStatus;
  readonly embeddingModel: string | null;
  readonly embeddingDimensions: number | null;
  readonly embeddingError: { readonly code: string; readonly message: string } | null;
  readonly sourceEligible: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type RagChunksListPayload = {
  readonly items: readonly RagChunkDto[];
} & {
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMore: boolean;
};

export type RagIndexSourcePayload = {
  readonly sourceType: RagChunkSourceType;
  readonly sourceId: string;
} & RagIndexResult;

export type RagPurgeSourcePayload = {
  readonly sourceType: RagChunkSourceType;
  readonly sourceId: string;
  readonly chunksRemoved: number;
};

export type RagStatusPayload = RagStatusReport;

export function toRagChunkDto(doc: RagChunkDocument): RagChunkDto {
  return {
    id: doc._id.toHexString(),
    sourceType: doc.sourceType,
    sourceId: doc.sourceId.toHexString(),
    chunkIndex: doc.chunkIndex,
    textLength: doc.textLength,
    textHash: doc.textHash,
    sourceHash: doc.sourceHash,
    embeddingStatus: doc.embeddingStatus,
    embeddingModel: doc.embeddingModel,
    embeddingDimensions: doc.embeddingDimensions,
    embeddingError: doc.embeddingError ?? null,
    sourceEligible: doc.sourceEligible,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
