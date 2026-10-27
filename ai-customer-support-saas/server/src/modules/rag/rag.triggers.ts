import { Types } from 'mongoose';

import { logger } from '../../core/logger/logger.js';

import { getEmbeddingProvider } from './embeddings/embedding.factory.js';
import {
  hideSourceFromRetrieval,
  indexKnowledgeBaseArticle,
  indexWorkspaceDocument,
  purgeSourceChunks,
} from './rag-indexing.service.js';
import type { RagChunkSourceType } from './rag.types.js';

/**
 * Source-lifecycle triggers (Prompt 13) — the plumbing that keeps the chunk
 * projection honest when sources change OUTSIDE the manual endpoints:
 *
 *   article PUBLISHED            → index (auto if a provider is configured)
 *   article content edited       → reindex (PUBLISHED only)
 *   article unpublished/restored → chunks lose eligibility (vectors kept —
 *                                  cheap re-eligibilization on republish)
 *   article archived             → chunks purged
 *   document extraction COMPLETED→ index
 *   document deleted             → chunks purged
 *
 * All trigger work is FIRE-SAFE: failures are logged, never break the
 * user-visible source mutation (the same convention the audit helpers use).
 * When no embedding provider is configured, auto triggers no-op silently —
 * indexing stays a deliberate operational decision until configuration lands.
 */
function workspaceObjectId(workspaceId: string): Types.ObjectId | undefined {
  if (!Types.ObjectId.isValid(workspaceId)) return undefined;
  return new Types.ObjectId(workspaceId);
}

export function scheduleArticleChunkIndexing(
  workspaceId: string,
  articleId: string,
): void {
  const ws = workspaceObjectId(workspaceId);
  const sourceId = Types.ObjectId.isValid(articleId) ? new Types.ObjectId(articleId) : undefined;
  if (ws === undefined || sourceId === undefined) return;
  if (getEmbeddingProvider() === null) return; // Dormant until configured.

  setImmediate(() => {
    void indexKnowledgeBaseArticle(ws, sourceId).catch((error: unknown) => {
      logger.error({ err: error, articleId }, 'auto article indexing failed');
    });
  });
}

export function scheduleDocumentChunkIndexing(
  workspaceId: string,
  documentId: string,
): void {
  const ws = workspaceObjectId(workspaceId);
  const sourceId = Types.ObjectId.isValid(documentId) ? new Types.ObjectId(documentId) : undefined;
  if (ws === undefined || sourceId === undefined) return;
  if (getEmbeddingProvider() === null) return; // Dormant until configured.

  setImmediate(() => {
    void indexWorkspaceDocument(ws, sourceId).catch((error: unknown) => {
      logger.error({ err: error, documentId }, 'auto document indexing failed');
    });
  });
}

export function scheduleSourceChunkIneligibility(
  workspaceId: string,
  sourceType: RagChunkSourceType,
  sourceId: string,
): void {
  const ws = workspaceObjectId(workspaceId);
  const source = Types.ObjectId.isValid(sourceId) ? new Types.ObjectId(sourceId) : undefined;
  if (ws === undefined || source === undefined) return;

  setImmediate(() => {
    void hideSourceFromRetrieval(ws, sourceType, source)
      .then((modified) => {
        if (modified > 0) {
          logger.debug({ sourceType, modified }, 'source chunks marked ineligible');
        }
      })
      .catch((error: unknown) => {
        logger.error({ err: error, sourceId }, 'chunk ineligibility update failed');
      });
  });
}

export function scheduleSourceChunkPurge(
  workspaceId: string,
  sourceType: RagChunkSourceType,
  sourceId: string,
): void {
  const ws = workspaceObjectId(workspaceId);
  const source = Types.ObjectId.isValid(sourceId) ? new Types.ObjectId(sourceId) : undefined;
  if (ws === undefined || source === undefined) return;

  setImmediate(() => {
    void purgeSourceChunks(ws, sourceType, source).catch((error: unknown) => {
      logger.error({ err: error, sourceId }, 'chunk purge failed');
    });
  });
}
