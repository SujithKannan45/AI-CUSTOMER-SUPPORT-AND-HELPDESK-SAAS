import type { Request, RequestHandler } from 'express';
import { Types } from 'mongoose';

import { asyncHandler, sendSuccess } from '../../core/http/api-response.js';

import { indexKnowledgeBaseArticle, indexWorkspaceDocument, purgeSourceChunks } from './rag-indexing.service.js';
import { ragStatusReport } from './rag-status.service.js';
import { toRagChunkDto, type RagChunksListPayload, type RagIndexSourcePayload, type RagPurgeSourcePayload, type RagStatusPayload } from './rag.dto.js';
import { listChunks } from './rag.repository.js';
import type { RagChunksQuery } from './rag.validation.js';

/**
 * RAG management controllers — HTTP shape only (parse → service → respond).
 * Authorization has ALREADY happened in middleware:
 *
 *   requireAuth → validate(...) → requireWorkspaceContext() → requirePermission(...)
 *
 * (Same composition as the documents module — rag.rbac decisions live in the
 * centralized registry; controllers never compare roles.)
 */

export interface RagValidatedRequest extends Request {
  readonly validated?: {
    readonly params?: {
      readonly workspaceId?: string;
      readonly fileId?: string;
      readonly articleId?: string;
      readonly sourceId?: string;
      readonly sourceType?: string;
    };
  };
}

function workspaceIdOf(req: RagValidatedRequest): Types.ObjectId {
  return new Types.ObjectId(req.workspace!.workspaceId);
}

export const ragStatusController: RequestHandler = asyncHandler(async (req, res) => {
  const payload: RagStatusPayload = await ragStatusReport(workspaceIdOf(req as RagValidatedRequest));
  sendSuccess(res, 200, payload, req);
});

export const listChunksController: RequestHandler = asyncHandler(async (req, res) => {
  // validate(..., 'query') REPLACES req.query with the parsed value (Express 5
  // behavior of the shared middleware) — read it directly, same as documents/KB.
  const query = req.query as unknown as RagChunksQuery;
  const workspaceId = workspaceIdOf(req as RagValidatedRequest);

  const result = await listChunks({
    workspaceId,
    page: query.page,
    limit: query.limit,
    sourceType: query.sourceType,
    sourceId: query.sourceId !== undefined ? new Types.ObjectId(query.sourceId) : undefined,
    embeddingStatus: query.embeddingStatus,
  });

  const payload: RagChunksListPayload = {
    items: result.items.map(toRagChunkDto),
    page: query.page,
    limit: query.limit,
    total: result.total,
    hasMore: result.hasMore,
  };
  sendSuccess(res, 200, payload, req);
});

/** POST /documents/:fileId/index — index (or reindex) one workspace document. */
export const indexDocumentController: RequestHandler = asyncHandler(async (req, res) => {
  const validated = (req as RagValidatedRequest).validated!;
  const workspaceId = workspaceIdOf(req as RagValidatedRequest);
  const documentId = new Types.ObjectId(validated.params!.fileId!);
  const actorId = Types.ObjectId.isValid(req.auth!.userId)
    ? new Types.ObjectId(req.auth!.userId)
    : undefined;

  const result = await indexWorkspaceDocument(workspaceId, documentId);
  const payload: RagIndexSourcePayload = {
    sourceType: 'DOCUMENT',
    sourceId: documentId.toHexString(),
    ...result,
  };
  sendSuccess(res, 200, payload, req);

  // Audit AFTER the response object is composed (API-driven runs only —
  // auto triggers from source lifecycle events do not carry an actor).
  if (actorId !== undefined && result.outcome !== 'UNCHANGED') {
    const { recordRagAudit, RAG_AUDIT_ACTIONS } = await import('./rag-audit.js');
    recordRagAudit({
      action: RAG_AUDIT_ACTIONS.sourceIndexed,
      workspaceId,
      actorId,
      resourceId: documentId.toHexString(),
      metadata: {
        sourceType: 'DOCUMENT',
        outcome: result.outcome,
        skipReason: result.skipReason ?? null,
        chunksIndexed: result.chunksIndexed,
        chunksReused: result.chunksReused,
        chunksRemoved: result.chunksRemoved,
        embeddingFailures: result.embeddingFailures,
      },
      request: req,
    });
  }
});

/** POST /articles/:articleId/index — index (or reindex) one KB article. */
export const indexArticleController: RequestHandler = asyncHandler(async (req, res) => {
  const validated = (req as RagValidatedRequest).validated!;
  const workspaceId = workspaceIdOf(req as RagValidatedRequest);
  const articleId = new Types.ObjectId(validated.params!.articleId!);
  const actorId = Types.ObjectId.isValid(req.auth!.userId)
    ? new Types.ObjectId(req.auth!.userId)
    : undefined;

  const result = await indexKnowledgeBaseArticle(workspaceId, articleId);
  const payload: RagIndexSourcePayload = {
    sourceType: 'KB_ARTICLE',
    sourceId: articleId.toHexString(),
    ...result,
  };
  sendSuccess(res, 200, payload, req);

  if (actorId !== undefined && result.outcome !== 'UNCHANGED') {
    const { recordRagAudit, RAG_AUDIT_ACTIONS } = await import('./rag-audit.js');
    recordRagAudit({
      action: RAG_AUDIT_ACTIONS.sourceIndexed,
      workspaceId,
      actorId,
      resourceId: articleId.toHexString(),
      metadata: {
        sourceType: 'KB_ARTICLE',
        outcome: result.outcome,
        skipReason: result.skipReason ?? null,
        chunksIndexed: result.chunksIndexed,
        chunksReused: result.chunksReused,
        chunksRemoved: result.chunksRemoved,
        embeddingFailures: result.embeddingFailures,
      },
      request: req,
    });
  }
});

/** DELETE /sources/:sourceType/:sourceId — purge every chunk of one source. */
export const purgeSourceController: RequestHandler = asyncHandler(async (req, res) => {
  const validated = (req as RagValidatedRequest).validated!;
  const workspaceId = workspaceIdOf(req as RagValidatedRequest);
  const sourceType = validated.params!.sourceType!;
  const sourceId = new Types.ObjectId(validated.params!.sourceId!);
  const actorId = Types.ObjectId.isValid(req.auth!.userId)
    ? new Types.ObjectId(req.auth!.userId)
    : undefined;

  const chunksRemoved = await purgeSourceChunks(
    workspaceId,
    sourceType as 'KB_ARTICLE' | 'DOCUMENT',
    sourceId,
  );
  const payload: RagPurgeSourcePayload = {
    sourceType: sourceType as 'KB_ARTICLE' | 'DOCUMENT',
    sourceId: sourceId.toHexString(),
    chunksRemoved,
  };
  sendSuccess(res, 200, payload, req);

  if (actorId !== undefined && chunksRemoved > 0) {
    const { recordRagAudit, RAG_AUDIT_ACTIONS } = await import('./rag-audit.js');
    recordRagAudit({
      action: RAG_AUDIT_ACTIONS.sourcePurged,
      workspaceId,
      actorId,
      resourceId: sourceId.toHexString(),
      metadata: { sourceType, chunksRemoved },
      request: req,
    });
  }
});
