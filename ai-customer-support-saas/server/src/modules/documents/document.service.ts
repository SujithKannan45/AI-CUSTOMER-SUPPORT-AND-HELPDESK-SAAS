import { createHash, randomUUID } from 'node:crypto';

import { Types } from 'mongoose';

import { AppError } from '../../core/errors/app-error.js';
import { logger } from '../../core/logger/logger.js';
import { findArticleInWorkspace } from '../knowledge-base/kb-article.repository.js';

import {
  recordDocumentAudit,
  DOCUMENT_AUDIT_ACTIONS,
} from './document-audit.js';
import {
  toDocumentDto,
  toDocumentSummaryDto,
  type DocumentDeletedPayload,
  type DocumentDetailPayload,
  type DocumentDownloadPayload,
  type DocumentListPayload,
  type DocumentRequestContext,
} from './document.dto.js';
import {
  composeStorageKey,
  sniffDocumentMedia,
  type SniffErrorCode,
} from './document.media.js';
import { scheduleDocumentExtraction, scheduleDocumentReprocessing } from './document.processing.js';
import {
  createDocumentRecord,
  findDocumentInWorkspace,
  listDocuments,
  purgeDocumentMetadata,
} from './document.repository.js';
import type { ListDocumentsQuery, UploadFieldsInput } from './document.validation.js';
import { getStorageService } from './storage/storage.factory.js';

/**
 * Document business flows (controllers stay thin; authorization has ALREADY
 * run in middleware — this layer adds sniffing, checksums, tenant-scoped
 * attach-points and storability rules).
 *
 * Laws:
 * - Client content types are INPUTS, never the decision: the sniffed/
 *   validated media type is what gets stored (see document.media.ts).
 * - The storage KEY is composed server-side (`workspaces/{ws}/files/{uuid}
 *   .ext`); the client filename is sanitized METADATA only.
 * - Bytes exist BEFORE metadata (putObject first): a DB failure after upload
 *   is cleaned up with a best-effort object delete, so no orphan metadata
 *   ever points at nothing; a leaked orphan object (metadata failed + cleanup
 *   failed) retains no private value (workspace-namespaced key, public-free
 *   access) and is documented in the data-model doc.
 * - The KB attach-point is validated AGAINST THE SAME WORKSPACE: foreign
 *   article ids read as 404 exactly like unknown ones (no cross-tenant
 *   existence oracle).
 */
const DOCUMENT_NOT_FOUND = 'Document not found';

export async function uploadDocumentFlow(
  context: DocumentRequestContext,
  file: { readonly mimetype: string; readonly originalname: string; readonly size: number; readonly buffer: Buffer },
  fields: UploadFieldsInput,
): Promise<DocumentDetailPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const actorId = new Types.ObjectId(context.actorId);

  const sniff = sniffDocumentMedia(file.mimetype ?? '', file.originalname ?? '', file.buffer);
  if (!sniff.accepted) {
    throw sniffFailure(sniff.code, sniff.message);
  }

  // Optional KB attach-point: format + same-workspace existence (server-side).
  let articleId: Types.ObjectId | null = null;
  if (fields.articleId !== undefined) {
    articleId = new Types.ObjectId(fields.articleId);
    const article = await findArticleInWorkspace(workspaceId, articleId);
    if (article === null) {
      throw AppError.notFound('Attach-article not found; upload without an article reference or pick an article in this workspace');
    }
  }

  const checksum = createHash('sha256').update(file.buffer).digest('hex');
  const uuid = randomUUID();
  const storageKey = composeStorageKey(context.workspaceId, sniff.mediaType, uuid);
  const storage = getStorageService();
  // DocumentMediaType string IS the canonical content type (registry invariants).
  const stored = await storage
    .putObject({ key: storageKey, body: file.buffer, contentType: sniff.mediaType })
    .catch((error: unknown) => {
      logger.error({ err: error }, 'document storage putObject failed');
      throw new AppError('The file could not be stored', {
        statusCode: 500,
        code: 'DOCUMENT_STORAGE_FAILED',
      });
    });

  let created;
  try {
    created = await createDocumentRecord(workspaceId, {
      originalFilename: sniff.filename,
      storageKey,
      mediaType: sniff.mediaType,
      sizeBytes: stored.size,
      storageProvider: stored.bucket,
      checksumSha256: checksum,
      uploadedById: actorId,
      articleId,
    });
  } catch (error: unknown) {
    // Metadata failed ⇒ bytes are pointless: cleanup best-effort, then fail loudly.
    try {
      await storage.deleteObject(storageKey);
    } catch (cleanupError: unknown) {
      logger.error({ err: cleanupError, storageKey }, 'document cleanup after metadata failure also failed');
    }
    throw error;
  }

  scheduleDocumentExtraction(context.workspaceId, created._id.toHexString());

  recordDocumentAudit({
    action: DOCUMENT_AUDIT_ACTIONS.documentUploaded,
    workspaceId,
    actorId,
    resourceId: created._id.toHexString(),
    metadata: {
      mediaType: created.mediaType,
      sizeBytes: created.sizeBytes,
      checksumSha256: checksum,
      storageProvider: created.storageProvider,
      ...(articleId !== null ? { articleId: articleId.toHexString() } : {}),
    },
  });

  return { document: toDocumentDto(created) };
}

function sniffFailure(code: SniffErrorCode, message: string): AppError {
  if (code === 'FILENAME_REQUIRED' || code === 'EMPTY_FILE') {
    return AppError.validation(message);
  }
  return new AppError(message, { statusCode: 415, code });
}

export async function getDocumentFlow(
  context: DocumentRequestContext,
  fileId: string,
): Promise<DocumentDetailPayload> {
  const document = await findDocumentInWorkspace(
    new Types.ObjectId(context.workspaceId),
    new Types.ObjectId(fileId),
  );
  if (document === null) throw AppError.notFound(DOCUMENT_NOT_FOUND);
  return { document: toDocumentDto(document) };
}

export async function listDocumentsFlow(
  context: DocumentRequestContext,
  query: ListDocumentsQuery,
): Promise<DocumentListPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const result = await listDocuments({
    workspaceId,
    page: query.page,
    limit: query.limit,
    status: query.status,
    extractionStatus: query.extractionStatus,
    articleId: query.articleId !== undefined ? new Types.ObjectId(query.articleId) : undefined,
    search: query.search,
  });

  return {
    items: result.items.map((doc) => toDocumentSummaryDto(doc)),
    page: query.page,
    limit: query.limit,
    total: result.total,
    hasMore: result.hasMore,
  };
}

/**
 * Byte delivery — ALWAYS via this authenticated, permission-checked endpoint.
 * The local driver streams from the process; the S3 driver hands back a short
 * expiring presigned URL the browser follows. Either way, content type is
 * forced to application/octet-stream at the boundary.
 */
export async function getDocumentDownloadFlow(
  context: DocumentRequestContext,
  fileId: string,
): Promise<DocumentDownloadPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const document = await findDocumentInWorkspace(workspaceId, new Types.ObjectId(fileId));
  if (document === null) throw AppError.notFound(DOCUMENT_NOT_FOUND);

  const storage = getStorageService();
  const bytes = await storage.getObject(document.storageKey).catch((error: unknown) => {
    logger.error({ err: error, storageKey: document.storageKey }, 'document storage getObject failed');
    throw new AppError('The file bytes are currently unavailable', {
      statusCode: 500,
      code: 'DOCUMENT_STORAGE_FAILED',
    });
  });

  return {
    filename: document.originalFilename,
    sizeBytes: bytes.byteLength,
    bytes,
  };
}

/**
 * Re-arm extraction on an existing document (repair path for FAILED runs and
 * for PROCESSING rows stranded by a crashed process). Returns the CURRENT
 * state; the run updates the row asynchronously — 202 semantics.
 */
export async function reprocessDocumentFlow(
  context: DocumentRequestContext,
  fileId: string,
): Promise<DocumentDetailPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const document = await findDocumentInWorkspace(workspaceId, new Types.ObjectId(fileId));
  if (document === null) throw AppError.notFound(DOCUMENT_NOT_FOUND);

  scheduleDocumentReprocessing(context.workspaceId, fileId);

  recordDocumentAudit({
    action: DOCUMENT_AUDIT_ACTIONS.documentReprocessed,
    workspaceId,
    actorId: new Types.ObjectId(context.actorId),
    resourceId: document._id.toHexString(),
  });

  // Return the CURRENT state; the run updates the row asynchronously —
  // 202 semantics.
  return getDocumentFlow(context, fileId);
}

/**
 * Terminal remove: purge the BYTES first (a lost purge fails the request and
 * keeps everything consistent: metadata stays live and the caller can retry),
 * then stamp deletedAt so the row leaves every live read; metadata is kept
 * forever for the audit trail, with no restore path (documented decision —
 * restore requires operator tooling, not an endpoint).
 */
export async function deleteDocumentFlow(
  context: DocumentRequestContext,
  fileId: string,
): Promise<DocumentDeletedPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const actorId = new Types.ObjectId(context.actorId);
  const selfId = new Types.ObjectId(fileId);

  const document = await findDocumentInWorkspace(workspaceId, selfId);
  if (document === null) throw AppError.notFound(DOCUMENT_NOT_FOUND);

  const storage = getStorageService();
  await storage.deleteObject(document.storageKey).catch((error: unknown) => {
    logger.error({ err: error, storageKey: document.storageKey }, 'document storage deleteObject failed');
    throw new AppError('The stored file could not be removed', {
      statusCode: 500,
      code: 'DOCUMENT_STORAGE_FAILED',
    });
  });

  await purgeDocumentMetadata(workspaceId, selfId, actorId);

  recordDocumentAudit({
    action: DOCUMENT_AUDIT_ACTIONS.documentDeleted,
    workspaceId,
    actorId,
    resourceId: document._id.toHexString(),
    metadata: {
      mediaType: document.mediaType,
      sizeBytes: document.sizeBytes,
      checksumSha256: document.checksumSha256,
    },
  });

  return { id: document._id.toHexString() };
}
