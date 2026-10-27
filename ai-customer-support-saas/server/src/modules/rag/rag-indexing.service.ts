import type { Types } from 'mongoose';

import { env } from '../../config/env.config.js';
import { AppError } from '../../core/errors/app-error.js';
import { logger } from '../../core/logger/logger.js';
import { findDocumentInWorkspace } from '../documents/document.repository.js';
import { findArticleInWorkspace } from '../knowledge-base/kb-article.repository.js';

import {
  chunkSourceText,
  sha256Text,
  type ChunkUnit,
} from './chunking.js';
import { EmbeddingProviderError } from './embeddings/embedding-provider.interface.js';
import { getEmbeddingProvider } from './embeddings/embedding.factory.js';
import {
  hasSourceChunksWithHash,
  markSourceChunksEligible,
  markSourceChunksIneligible,
  replaceSourceChunks,
  deleteSourceChunks,
  findSourceChunks,
  type ChunkUpsertRecord,
  type ReplaceSourceChunksPlan,
} from './rag.repository.js';
import type {
  RagChunkSourceType,
  RagIndexResult,
  RagSkipReason,
} from './rag.types.js';

/**
 * Indexing pipeline (Prompt 13) — turns ELIGIBLE sources into retrievable
 * chunks. All operations compose the workspace scope server-side; no endpoint
 * body ever supplies workspaceId/source ownership.
 *
 * Idempotency & dedupe laws:
 * - source-hash short-circuit: an unchanged source (same normalized hash) is
 *   skipped WITHOUT writes — repeated indexing is free;
 * - text-hash reuse: unchanged chunk texts keep their stored embeddings (no
 *   provider call), so partial edits re-embed only what changed;
 * - upserts key on the unique position index, so repeated/concurrent runs
 *   cannot duplicate chunks.
 *
 * Partial-failure semantics (documented, no transactions in this deployment):
 * an upsert failure aborts the run with the error untouched — the unique
 * index plus reindex-by-sourceHash make the next run complete the state.
 * Embedding failures are PRE-COMMITTED as per-chunk FAILED rows (safe error,
 * vector null, sourceEligible stays true) so a retrieval query can never see
 * a half-indexed source as fully complete, and a later reindex repairs it.
 */

/** Composes the embedding input for a KB article (stable across reindexes). */
function composeArticleSourceText(article: {
  title: string;
  summary: string;
  body: string;
  tags: readonly string[];
}): string {
  const tagsLine = article.tags.length > 0 ? `\n\nTags: ${article.tags.join(', ')}` : '';
  return `${article.title}\n\n${article.summary}\n\n${article.body}${tagsLine}`;
}

interface SourceEligibility {
  readonly eligible: boolean;
  readonly sourceText?: string;
  readonly skipReason?: RagSkipReason;
}

export async function resolveArticleIndexingEligibility(
  workspaceId: Types.ObjectId,
  articleId: Types.ObjectId,
): Promise<SourceEligibility> {
  const article = await findArticleInWorkspace(workspaceId, articleId);
  if (article === null) {
    // Same contract as every other module: a foreign/unknown id is a 404 —
    // never an eligibility leak about a neighbor tenant's content.
    throw AppError.notFound('Article not found');
  }
  if (article.status === 'ARCHIVED') {
    return { eligible: false, skipReason: 'ARTICLE_NOT_PUBLISHED' };
  }
  if (article.status !== 'PUBLISHED') {
    return { eligible: false, skipReason: 'ARTICLE_NOT_PUBLISHED' };
  }
  return { eligible: true, sourceText: composeArticleSourceText(article) };
}

export async function resolveDocumentIndexingEligibility(
  workspaceId: Types.ObjectId,
  documentId: Types.ObjectId,
): Promise<SourceEligibility> {
  const document = await findDocumentInWorkspace(workspaceId, documentId);
  if (document === null) {
    throw AppError.notFound('Document not found');
  }
  if (document.status !== 'COMPLETED' || document.extractionStatus !== 'COMPLETED') {
    return { eligible: false, skipReason: 'EXTRACTED_TEXT_UNAVAILABLE' };
  }
  if (document.extractedText === null || document.extractedText.trim().length === 0) {
    return { eligible: false, skipReason: 'EXTRACTED_TEXT_UNAVAILABLE' };
  }
  return { eligible: true, sourceText: document.extractedText };
}

/**
 * The single indexing engine behind both source types.
 * REQUIRES the caller to have validated source existence (or accepts a skip
 * from eligibility resolution, which reads the source tenant-scoped itself).
 */
async function indexSourceText(
  workspaceId: Types.ObjectId,
  sourceType: RagChunkSourceType,
  sourceId: Types.ObjectId,
  sourceText: string,
): Promise<RagIndexResult> {
  const provider = getEmbeddingProvider();
  if (provider === null) {
    throw new AppError('Embedding generation is not configured for this deployment', {
      statusCode: 503,
      code: 'RAG_EMBEDDING_NOT_CONFIGURED',
    });
  }

  const chunking = chunkSourceText(sourceText);
  if (chunking.status === 'REJECTED') {
    // Ineligible content (empty/oversized): remove any stale index of it.
    const removed = await deleteSourceChunks(workspaceId, sourceType, sourceId);
    return {
      outcome: 'SKIPPED',
      skipReason: chunking.reason,
      chunksIndexed: 0,
      chunksReused: 0,
      chunksRemoved: removed,
      embeddingFailures: 0,
    };
  }

  // Reindex short-circuit: identical source content → no content writes.
  // A republish after an unpublished window re-eligibilizes the KEPT chunks
  // here (mirrors the unpublish trigger's hide); re-embeds stay free.
  if (await hasSourceChunksWithHash(workspaceId, sourceType, sourceId, chunking.sourceHash)) {
    const reeligibilized = await markSourceChunksEligible(
      workspaceId,
      sourceType,
      sourceId,
    );
    return {
      outcome: 'UNCHANGED',
      chunksIndexed: 0,
      chunksReused: reeligibilized,
      chunksRemoved: 0,
      embeddingFailures: 0,
    };
  }

  const existing = await findSourceChunks(workspaceId, sourceType, sourceId);
  const existingByIndex = new Map<number, (typeof existing)[number]>();
  for (const chunk of existing) existingByIndex.set(chunk.chunkIndex, chunk);

  const existingSourceHashes = new Set(existing.map((chunk) => chunk.sourceHash));
  const staleAny = existing.length > 0 && !existingSourceHashes.has(chunking.sourceHash);

  // Split desired chunk set into reused (same normalized text) and to-embed.
  const reused: Array<{ unit: ChunkUnit; embedding: (typeof existing)[number] }> = [];
  const needingEmbedding: ChunkUnit[] = [];
  for (const unit of chunking.chunks) {
    const prior = existingByIndex.get(unit.chunkIndex);
    if (
      prior !== undefined &&
      prior.textHash === unit.textHash &&
      prior.embeddingStatus === 'COMPLETED' &&
      prior.embeddingModel === provider.model &&
      prior.embeddingDimensions === provider.dimensions &&
      Array.isArray(prior.embedding)
    ) {
      reused.push({ unit, embedding: prior });
    } else {
      needingEmbedding.push(unit);
    }
  }

  // Batch embed what changed (respecting the configured batch size).
  let embeddingFailures = 0;
  const providerFailure: { code: string; message: string }[] = [];
  const embeddedEmbeddings = new Map<number, { vector: readonly number[]; error: null }>();
  const failedUnits = new Set<number>();

  for (let start = 0; start < needingEmbedding.length; start += env.RAG_EMBEDDING_BATCH_SIZE) {
    const batchUnits = needingEmbedding.slice(start, start + env.RAG_EMBEDDING_BATCH_SIZE);
    try {
      const vectors = await provider.embedBatch(batchUnits.map((unit) => unit.text));
      batchUnits.forEach((unit, position) => {
        embeddedEmbeddings.set(unit.chunkIndex, { vector: vectors[position] as readonly number[], error: null });
      });
    } catch (error: unknown) {
      const typed = error instanceof EmbeddingProviderError ? error : undefined;
      const code = typed?.code ?? 'PROVIDER_UNAVAILABLE';
      const message = typed?.message ?? 'The embedding provider request failed';
      providerFailure.push({ code, message });
      if (typed === undefined) {
        logger.error({ err: error, sourceId: sourceId.toHexString() }, 'embedding provider failed unexpectedly');
      } else {
        logger.warn({ code: typed.code }, 'embedding provider batch failed');
      }
      for (const unit of batchUnits) failedUnits.add(unit.chunkIndex);
      embeddingFailures += batchUnits.length;
    }
  }

  // Build the upsert plan: COMPLETED (newly embedded OR reused) plus
  // PRE-COMMITTED FAILED rows for provider failures.
  const sourceHash = chunking.sourceHash;
  const upserts = ((): ReplaceSourceChunksPlan['upserts'] => [
    ...reused.map(({ unit, embedding }) => ({
      chunkIndex: unit.chunkIndex,
      text: unit.text,
      textLength: unit.textLength,
      textHash: unit.textHash,
      sourceHash,
      embeddingStatus: 'COMPLETED' as const,
      embeddingModel: embedding.embeddingModel,
      embeddingDimensions: embedding.embeddingDimensions,
      embeddingError: null,
      embedding: [...(embedding.embedding as number[])],
    })),
    ...needingEmbedding.map((unit): ChunkUpsertRecord => {
      const embedded = embeddedEmbeddings.get(unit.chunkIndex);
      const failed = failedUnits.has(unit.chunkIndex);
      return {
        chunkIndex: unit.chunkIndex,
        text: unit.text,
        textLength: unit.textLength,
        textHash: unit.textHash,
        sourceHash,
        embeddingStatus: (failed ? 'FAILED' : 'COMPLETED'),
        embeddingModel: failed ? null : provider.model,
        embeddingDimensions: failed ? null : provider.dimensions,
        embeddingError: failed ? (providerFailure[0] ?? { code: 'PROVIDER_UNAVAILABLE', message: 'The embedding provider request failed' }) : null,
        embedding: embedded !== undefined ? [...embedded.vector] : null,
      };
    }),
  ])();

  const removeIndexes = staleAny
    ? existing
        .map((chunk) => chunk.chunkIndex)
        .filter((index) => !chunking.chunks.some((unit) => unit.chunkIndex === index))
    : [];

  const { upserted, deleted } = await replaceSourceChunks(workspaceId, sourceType, sourceId, {
    upserts,
    removeIndexes,
  });

  return {
    outcome: 'INDEXED',
    chunksIndexed: upserted,
    chunksReused: reused.length,
    chunksRemoved: deleted,
    embeddingFailures,
  };
}

/** Indexes (or reindexes) one PUBLISHED KB article. */
export async function indexKnowledgeBaseArticle(
  workspaceId: Types.ObjectId,
  articleId: Types.ObjectId,
): Promise<RagIndexResult> {
  const eligibility = await resolveArticleIndexingEligibility(workspaceId, articleId);
  if (!eligibility.eligible) {
    return {
      outcome: 'SKIPPED',
      skipReason: eligibility.skipReason,
      chunksIndexed: 0,
      chunksReused: 0,
      chunksRemoved: 0,
      embeddingFailures: 0,
    };
  }
  return indexSourceText(workspaceId, 'KB_ARTICLE', articleId, eligibility.sourceText as string);
}

/** Indexes (or reindexes) one COMPLETED-extraction document. */
export async function indexWorkspaceDocument(
  workspaceId: Types.ObjectId,
  documentId: Types.ObjectId,
): Promise<RagIndexResult> {
  const eligibility = await resolveDocumentIndexingEligibility(workspaceId, documentId);
  if (!eligibility.eligible) {
    return {
      outcome: 'SKIPPED',
      skipReason: eligibility.skipReason,
      chunksIndexed: 0,
      chunksReused: 0,
      chunksRemoved: 0,
      embeddingFailures: 0,
    };
  }
  return indexSourceText(workspaceId, 'DOCUMENT', documentId, eligibility.sourceText as string);
}

/** Purges every chunk of one source (delete/archive/repair path). Idempotent. */
export async function purgeSourceChunks(
  workspaceId: Types.ObjectId,
  sourceType: RagChunkSourceType,
  sourceId: Types.ObjectId,
): Promise<number> {
  return deleteSourceChunks(workspaceId, sourceType, sourceId);
}

/**
 * Availability-response layer for USER-FACING pages: markSourceChunksIneligible
 * keeps vectors but hides them from retrieval (cheap unpublish → republish).
 */
export async function hideSourceFromRetrieval(
  workspaceId: Types.ObjectId,
  sourceType: RagChunkSourceType,
  sourceId: Types.ObjectId,
): Promise<number> {
  return markSourceChunksIneligible(workspaceId, sourceType, sourceId);
}

/** SHA-256 over composed article text — exported for the verification driver. */
export const composeArticleTextForTests = composeArticleSourceText;
export const sourceTextSha256 = sha256Text;
