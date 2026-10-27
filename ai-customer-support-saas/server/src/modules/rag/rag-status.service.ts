import type { Types } from 'mongoose';

import { env } from '../../config/env.config.js';
import { DocumentFileModel } from '../documents/document.model.js';
import { KbArticleModel } from '../knowledge-base/kb.model.js';

import { getEmbeddingProvider } from './embeddings/embedding.factory.js';
import { chunkStatusCounts } from './rag.repository.js';
import { getVectorStore } from './vector/vector.factory.js';

/**
 * Indexing status report (Prompt 13) — the operational read the management
 * endpoints serve. Deliberately cheap: one indexed aggregate on rag_chunks
 * plus three count queries over source collections.
 */
export interface RagSourceIneligibility {
  /** Draft (not-yet-published) articles — content indexing CANNOT see them. */
  readonly draftArticles: number;
  readonly documentsPendingExtraction: number;
  readonly documentsFailedExtraction: number;
}

export interface RagStatusReport {
  readonly embeddingProvider: string | null;
  readonly embeddingModel: string | null;
  readonly embeddingDimensions: number | null;
  readonly vectorStore: 'atlas' | 'inmemory' | null;
  readonly chunkCounts: Awaited<ReturnType<typeof chunkStatusCounts>>;
  readonly sourcesIneligible: RagSourceIneligibility;
}

export async function ragStatusReport(workspaceId: Types.ObjectId): Promise<RagStatusReport> {
  const provider = getEmbeddingProvider();
  const store = getVectorStore();

  const [chunkCounts, draftArticles, pendingExtraction, failedExtraction] = await Promise.all([
    chunkStatusCounts(workspaceId),
    KbArticleModel.countDocuments({ workspaceId, status: 'DRAFT' }),
    DocumentFileModel.countDocuments({
      workspaceId,
      status: 'PROCESSING',
      extractionStatus: 'PENDING',
    }),
    DocumentFileModel.countDocuments({ workspaceId, extractionStatus: 'FAILED' }),
  ]);

  return {
    embeddingProvider: provider?.name ?? null,
    embeddingModel: provider?.model ?? null,
    embeddingDimensions:
      provider?.dimensions ??
      (env.RAG_EMBEDDING_PROVIDER === 'none' ? null : env.RAG_EMBEDDING_DIMENSIONS),
    vectorStore: store?.name ?? null,
    chunkCounts,
    sourcesIneligible: {
      draftArticles,
      documentsPendingExtraction: pendingExtraction,
      documentsFailedExtraction: failedExtraction,
    },
  };
}
