import { RagChunkModel } from '../rag.model.js';

import type {
  VectorMatch,
  VectorSearchInput,
  VectorStore,
} from './vector-store.interface.js';
import {
  cosineSimilarity,
  retrievalEligibilityFilter,
} from './vector-store.support.js';

/**
 * In-memory vector store (Prompt 13) — tests/development ONLY.
 *
 * Implementation: a bounded-projection Mongo scan (workspace + eligibility
 * filter INSIDE the query, per the isolation law) followed by an o(N) cosine
 * pass over the candidate vectors, sorted and cut to the result limit. The
 * scan is INDEX-backed, but the per-query vector math is still linear in the
 * workspace's chunk count — which is exactly why production defaults to
 * Atlas Vector Search and why this store is boot-refused in production
 * without an explicit RAG_ALLOW_INMEMORY_VECTOR_PRODUCTION escape hatch.
 *
 * "In-memory" describes the similarity math, not the storage: vectors live
 * in MongoDB (embedded in each chunk document) throughout, so a driver
 * restart never loses the index.
 */
export class InMemoryVectorStore implements VectorStore {
  public readonly name = 'inmemory' as const;

  public async searchByVector(input: VectorSearchInput): Promise<readonly VectorMatch[]> {
    const dimensions = input.queryVector.length;
    const candidates = await RagChunkModel.find(
      retrievalEligibilityFilter(input.workspaceId, dimensions),
      {
        text: 1,
        embedding: 1,
        sourceType: 1,
        sourceId: 1,
      },
    )
      .lean()
      .limit(20_000); // Administrative ceiling — out-of-bounds workspaces are simply huge.

    const scored = candidates
      .filter((candidate): candidate is typeof candidate & { embedding: number[] } =>
        Array.isArray(candidate.embedding) && candidate.embedding.length === dimensions)
      .map((candidate) => ({
        chunk: candidate,
        score: cosineSimilarity(input.queryVector, candidate.embedding),
      }))
      .filter((entry) => entry.score >= (input.minScore ?? 0))
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit);

    return scored.map((entry) => ({
      chunkId: String((entry.chunk._id).toHexString()),
      sourceType: entry.chunk.sourceType,
      sourceId: String(entry.chunk.sourceId),
      text: entry.chunk.text,
      score: entry.score,
    }));
  }
}
