import type { Types } from 'mongoose';

import type { WorkspaceRole } from '../workspaces/workspace.types.js';

import type {
  DocumentExtractionError,
  DocumentExtractionStatus,
  DocumentFile,
  DocumentStatus,
} from './document.types.js';

/**
 * Document module — DTOs, request context and query objects (the same split
 * kb.dto.ts / conversation.dto.ts established). The safe representation that
 * crosses the HTTP boundary lives here — never the raw Mongoose document.
 *
 * The FILE never crosses the boundary as a base64 blob: metadata DTOs for the
 * management surface, a streamed download endpoint for bytes. The storage
 * key is internal (it is provider-relevant, not client-relevant) and is
 * deliberately NOT in any DTO.
 */

/** Middleware-validated actor context (identical contract to kb.dto.ts). */
export interface DocumentRequestContext {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly role: WorkspaceRole;
}

// ── DTOs ──────────────────────────────────────────────────────────────────────

/** Shared shape; detail DTOs add the bounded extracted text. */
export interface DocumentFileSummaryDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly articleId: string | null;
  readonly originalFilename: string;
  readonly mediaType: DocumentFile['mediaType'];
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly status: DocumentStatus;
  readonly extractionStatus: DocumentExtractionStatus;
  readonly extractionError: DocumentExtractionError | null;
  readonly uploadedById: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Detail adds the EXTRACTION result (derived text), never the raw bytes. */
export interface DocumentFileDto extends DocumentFileSummaryDto {
  readonly extractedText: string | null;
  readonly extractedTextTruncated: boolean;
}

// ── Service payloads (controller envelope data) ───────────────────────────────

export interface DocumentDetailPayload {
  readonly document: DocumentFileDto;
}

export interface DocumentListPayload {
  readonly items: readonly DocumentFileSummaryDto[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMore: boolean;
}

export interface DocumentDeletedPayload {
  readonly id: string;
}

/** Download-flow result: bytes for streaming providers, never base64 blobs. */
export interface DocumentDownloadPayload {
  readonly filename: string;
  readonly sizeBytes: number;
  readonly bytes: Buffer;
}

// ── Mappers (the single place a document becomes a DTO) ───────────────────────

function toSummaryDto(doc: DocumentFile): DocumentFileSummaryDto {
  return {
    id: doc._id.toHexString(),
    workspaceId: doc.workspaceId.toHexString(),
    articleId: doc.articleId === null ? null : doc.articleId.toHexString(),
    originalFilename: doc.originalFilename,
    mediaType: doc.mediaType,
    sizeBytes: doc.sizeBytes,
    checksumSha256: doc.checksumSha256,
    status: doc.status,
    extractionStatus: doc.extractionStatus,
    extractionError:
      doc.extractionError === null ? null : { code: doc.extractionError.code, message: doc.extractionError.message },
    uploadedById: doc.uploadedById.toHexString(),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function toDocumentSummaryDto(doc: DocumentFile): DocumentFileSummaryDto {
  return toSummaryDto(doc);
}

export function toDocumentDto(doc: DocumentFile): DocumentFileDto {
  return {
    ...toSummaryDto(doc),
    extractedText: doc.extractedText,
    extractedTextTruncated: doc.extractedTextTruncated,
  };
}

// ── Service → repository query objects (already validated) ────────────────────

export interface DocumentUploadSpec {
  readonly workspaceId: Types.ObjectId;
  readonly uploadedById: Types.ObjectId;
  readonly filename: string;
  readonly mediaType: DocumentFile['mediaType'];
  readonly bytes: Buffer;
  readonly articleId: Types.ObjectId | null;
}

export interface DocumentListSpec {
  readonly workspaceId: Types.ObjectId;
  readonly page: number;
  readonly limit: number;
  readonly status?: DocumentStatus;
  readonly extractionStatus?: DocumentExtractionStatus;
  readonly articleId?: string;
  readonly search?: string;
}
