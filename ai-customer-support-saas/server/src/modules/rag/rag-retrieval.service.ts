import { Types } from 'mongoose';

import { env } from '../../config/env.config.js';
import { AppError } from '../../core/errors/app-error.js';
import { logger } from '../../core/logger/logger.js';

import { EmbeddingProviderError } from './embeddings/embedding-provider.interface.js';
import { getEmbeddingProvider } from './embeddings/embedding.factory.js';
import type { RagPassage } from './rag.types.js';
import { getVectorStore } from './vector/vector.factory.js';

/**
 * Retrieval service (Prompt 13) — the reusable, INTERNAL semantic search
 * boundary. Deliberately NOT exposed over HTTP yet: Prompt 14's answer
 * service and future authorized surfaces compose on this function.
 *
 * Guarantees:
 * - inputs are validated (non-empty bounded query, bounded limit);
 * - the query is embedded by the CONFIGURED provider (never fabricated);
 * - workspace + eligibility restrictions are applied INSIDE the store query
 *   (isolation law — see vector-store.interface.ts);
 * - failures are operational, safe (no provider internals), and coded.
 */
export interface RetrievalInput {
  readonly workspaceId: Types.ObjectId | string;
  readonly query: string;
  /** Optional bounded override (default: env limit). */
  readonly limit?: number;
  /** Optional similarity floor (default: env value; 0 disables). */
  readonly minScore?: number;
}

export async function retrievePassages(input: RetrievalInput): Promise<readonly RagPassage[]> {
  const query = input.query.trim();
  if (query.length === 0) {
    throw AppError.badRequest('The query must not be empty', { code: 'RAG_QUERY_EMPTY' });
  }
  if (query.length > env.RAG_QUERY_MAX_LENGTH) {
    throw AppError.badRequest(`The query exceeds ${env.RAG_QUERY_MAX_LENGTH} characters`, {
      code: 'RAG_QUERY_TOO_LONG',
    });
  }
  const workspaceId = new Types.ObjectId(input.workspaceId);
  const limit = input.limit ?? env.RAG_MAX_RETRIEVE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > env.RAG_MAX_RETRIEVE_LIMIT) {
    throw AppError.badRequest(
      `The limit must be between 1 and ${env.RAG_MAX_RETRIEVE_LIMIT}`,
      { code: 'RAG_LIMIT_OUT_OF_BOUNDS' },
    );
  }

  const provider = getEmbeddingProvider();
  if (provider === null) {
    throw new AppError('Embedding generation is not configured for this deployment', {
      statusCode: 503,
      code: 'RAG_EMBEDDING_NOT_CONFIGURED',
    });
  }
  const store = getVectorStore();
  if (store === null) {
    throw new AppError('Vector search is not configured for this deployment', {
      statusCode: 503,
      code: 'RAG_VECTOR_SEARCH_NOT_CONFIGURED',
    });
  }

  const queryVectors = await provider.embedBatch([query]).catch((error: unknown) => {
    const typed = error instanceof EmbeddingProviderError ? error : undefined;
    if (typed === undefined) {
      logger.error({ err: error }, 'query embedding failed unexpectedly');
    }
    throw new AppError('Semantic search is currently unavailable', {
      statusCode: 503,
      code: 'RAG_EMBEDDING_PROVIDER_FAILED',
      isOperational: true,
    });
  });
  const queryVector = queryVectors[0];
  if (queryVector === undefined) {
    throw new AppError('Semantic search is currently unavailable', {
      statusCode: 503,
      code: 'RAG_EMBEDDING_PROVIDER_FAILED',
      isOperational: true,
    });
  }

  const matches = await store
    .searchByVector({
      workspaceId,
      queryVector,
      limit,
      minScore: input.minScore ?? env.RAG_MIN_SCORE,
    })
    .catch((error: unknown) => {
      // The store already logs & wraps its technical cause safely.
      if (!(error instanceof AppError)) {
        logger.error({ err: error }, 'vector store search failed unexpectedly');
        throw new AppError('Semantic search is currently unavailable', {
          statusCode: 503,
          code: 'RAG_VECTOR_SEARCH_FAILED',
          isOperational: true,
        });
      }
      throw error;
    });

  return matches.map((match) => ({
    chunkId: match.chunkId,
    sourceType: match.sourceType,
    sourceId: match.sourceId,
    text: match.text,
    score: match.score,
  }));
}
