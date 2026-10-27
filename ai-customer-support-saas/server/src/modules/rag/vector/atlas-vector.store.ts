import type { Types } from 'mongoose';

import { AppError } from '../../../core/errors/app-error.js';
import { logger } from '../../../core/logger/logger.js';
import { RagChunkModel } from '../rag.model.js';
import type { RagChunkSourceType } from '../rag.types.js';

import type {
  VectorMatch,
  VectorSearchInput,
  VectorStore,
} from './vector-store.interface.js';
import {
  retrievalEligibilityFilter,
} from './vector-store.support.js';

/**
 * MongoDB Atlas Vector Search adapter (Prompt 13) — the PRODUCTION path.
 *
 * Uses the `$vectorSearch` aggregation stage with `filter:` set to the SAME
 * eligibility predicate as the in-memory store (workspace + sourceEligible +
 * COMPLETED embeddings + dimensionality), so tenant isolation is enforced by
 * the QUERY ITSELF, not by filtering results afterwards. `$vectorSearch`
 * supports equality-style prefilters on non-vector fields — exactly this
 * shape.
 *
 * REQUIREMENT (documented in docs/architecture.md): an Atlas Search index
 * named `env.RAG_ATLAS_VECTOR_INDEX` (default `rag_chunks_vector`) must exist
 * on the `rag_chunks` collection with `embedding` of type knnVector for the
 * configured dimensions (and workspaceId/sourceType indexed for the
 * prefilter). Without it the stage errors — which this adapter converts into
 * a single safe, non-leaking 503 (`RAG_VECTOR_SEARCH_FAILED`), never provider
 * internals, and the failure is logged server-side with the real cause.
 *
 * Atlas is NOT assumed to exist just because MongoDB is used: the factory
 * selects this store only on explicit configuration, and the local dev
 * topology (standalone mongod) simply cannot run it.
 */
export class AtlasVectorStore implements VectorStore {
  public readonly name = 'atlas' as const;

  public constructor(private readonly indexName: string) {}

  public async searchByVector(input: VectorSearchInput): Promise<readonly VectorMatch[]> {
    const dimensions = input.queryVector.length;
    try {
      const results = await RagChunkModel.aggregate<Record<string, unknown>>([
        {
          $vectorSearch: {
            index: this.indexName,
            path: 'embedding',
            queryVector: [...input.queryVector],
            numCandidates: Math.max(input.limit * 10, 100),
            limit: input.limit,
            filter: retrievalEligibilityFilter(input.workspaceId, dimensions),
          },
        },
        {
          $project: {
            _id: 1,
            sourceType: 1,
            sourceId: 1,
            text: 1,
            score: { $meta: 'vectorSearchScore' },
          },
        },
      ]);

      return results
        .filter((doc) => (doc['score'] as number) >= (input.minScore ?? 0))
        .map((doc) => ({
          chunkId: String((doc['_id'] as Types.ObjectId).toHexString()),
          sourceType: doc['sourceType'] as RagChunkSourceType,
          sourceId: String(doc['sourceId']),
          text: doc['text'] as string,
          score: doc['score'] as number,
        }));
    } catch (error: unknown) {
      logger.error(
        { err: error, indexName: this.indexName },
        'atlas vector search failed',
      );
      throw new AppError('Semantic search is currently unavailable', {
        statusCode: 503,
        code: 'RAG_VECTOR_SEARCH_FAILED',
        isOperational: true,
      });
    }
  }
}
