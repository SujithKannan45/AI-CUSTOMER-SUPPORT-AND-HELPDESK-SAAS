import type { Types } from 'mongoose';

import { AppError } from '../../core/errors/index.js';
import { assertTenantScope, tenantFilter } from '../../database/tenant.js';

import {
  DOCUMENT_WITH_PURGED,
  DocumentFileModel,
} from './document.model.js';
import type { DocumentFile } from './document.types.js';

/**
 * File-asset persistence layer — the ONLY module touching `file_assets`
 * (same contract as the KB repositories):
 *
 * - EVERY query is built through `tenantFilter()` and asserted with
 *   `assertTenantScope()`; document ids are composed into the filter here so
 *   a foreign id reads as not-found (no existence oracle across tenants).
 * - Reads hit the live-only hook by default (deleted file assets are hidden
 *   everywhere); delete internals opt out explicitly with DOCUMENT_WITH_PURGED.
 * - Mutations are SCOPED `findOneAndUpdate`s — never read-then-write.
 */

export interface DocumentMetadataRecord {
  readonly originalFilename: string;
  readonly storageKey: string;
  readonly mediaType: DocumentFile['mediaType'];
  readonly sizeBytes: number;
  readonly storageProvider: string;
  readonly checksumSha256: string;
  readonly uploadedById: Types.ObjectId;
  readonly articleId: Types.ObjectId | null;
}

export async function createDocumentRecord(
  workspaceId: Types.ObjectId,
  record: DocumentMetadataRecord,
): Promise<DocumentFile> {
  return DocumentFileModel.create({
    ...tenantFilter(workspaceId),
    ...record,
    status: 'PENDING',
    extractionStatus: 'PENDING',
  });
}

export async function findDocumentInWorkspace(
  workspaceId: Types.ObjectId,
  documentId: Types.ObjectId,
): Promise<DocumentFile | null> {
  const filter = {
    ...tenantFilter(workspaceId),
    _id: documentId,
  };
  assertTenantScope(filter, 'findDocumentInWorkspace');
  return DocumentFileModel.findOne(filter);
}

/** Delete internals only: reads the row including purged (deletedAt) ones. */
export async function findDocumentIncludingPurged(
  workspaceId: Types.ObjectId,
  documentId: Types.ObjectId,
): Promise<DocumentFile | null> {
  const filter = {
    ...tenantFilter(workspaceId),
    _id: documentId,
  };
  assertTenantScope(filter, 'findDocumentIncludingPurged');
  return DocumentFileModel.findOne(filter).setOptions(DOCUMENT_WITH_PURGED);
}

export interface DocumentListSpec {
  readonly workspaceId: Types.ObjectId;
  readonly page: number;
  readonly limit: number;
  readonly status?: DocumentFile['status'];
  readonly extractionStatus?: DocumentFile['extractionStatus'];
  readonly articleId?: Types.ObjectId;
  readonly search?: string;
}

export interface DocumentListResult {
  readonly items: readonly DocumentFile[];
  readonly total: number;
  readonly hasMore: boolean;
}

/**
 * Server-side filter chain — the client query never reaches Mongo raw:
 * status/extraction/article filters are enum/id validated upstream, and the
 * filename search is an ESCAPED case-insensitive regex on the original file
 * name (no user regex metacharacters survive: the service escapes).
 */
export async function listDocuments(spec: DocumentListSpec): Promise<DocumentListResult> {
  const filter: Record<string, unknown> = tenantFilter(spec.workspaceId);
  assertTenantScope(filter, 'listDocuments');
  if (spec.status !== undefined) filter['status'] = spec.status;
  if (spec.extractionStatus !== undefined) filter['extractionStatus'] = spec.extractionStatus;
  if (spec.articleId !== undefined) filter['articleId'] = spec.articleId;
  if (spec.search !== undefined && spec.search.length > 0) {
    filter['originalFilename'] = {
      $options: 'i',
      $regex: spec.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    };
  }

  const [items, total] = await Promise.all([
    DocumentFileModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((spec.page - 1) * spec.limit)
      .limit(spec.limit),
    DocumentFileModel.countDocuments(filter),
  ]);

  return { items, total, hasMore: spec.page * spec.limit < total };
}

/**
 * Atomically claims a document for extraction: the PROCESSING status is set
 * ONLY from an expected source state, so concurrent reprocess calls cannot
 * double-schedule (the loser loses the claim and its extraction run skips).
 */
export async function claimDocumentForProcessing(
  workspaceId: Types.ObjectId,
  documentId: Types.ObjectId,
  fromStatuses: readonly DocumentFile['status'][],
): Promise<DocumentFile | null> {
  const filter: Record<string, unknown> = {
    ...tenantFilter(workspaceId),
    _id: documentId,
    status: { $in: [...fromStatuses] },
    deletedAt: null,
  };
  assertTenantScope(filter, 'claimDocumentForProcessing');
  return DocumentFileModel.findOneAndUpdate(
    filter,
    { $set: { status: 'PROCESSING' } },
    { new: true },
  );
}

export interface DocumentProcessingPatch {
  readonly status: DocumentFile['status'];
  readonly extractionStatus: DocumentFile['extractionStatus'];
  readonly extractionError?: DocumentFile['extractionError'];
  readonly extractedText?: string | null;
  readonly extractedTextTruncated?: boolean;
}

export async function updateDocumentProcessingState(
  workspaceId: Types.ObjectId,
  documentId: Types.ObjectId,
  patch: DocumentProcessingPatch,
): Promise<DocumentFile | null> {
  const filter = {
    ...tenantFilter(workspaceId),
    _id: documentId,
    deletedAt: null,
  };
  assertTenantScope(filter, 'updateDocumentProcessingState');
  return DocumentFileModel.findOneAndUpdate(
    filter,
    {
      $set: {
        status: patch.status,
        extractionStatus: patch.extractionStatus,
        ...(patch.extractionError !== undefined
          ? { extractionError: patch.extractionError }
          : {}),
        ...(patch.extractedText !== undefined ? { extractedText: patch.extractedText } : {}),
        ...(patch.extractedTextTruncated !== undefined
          ? { extractedTextTruncated: patch.extractedTextTruncated }
          : {}),
      },
    },
    { new: true },
  );
}

/** Terminal delete: stamps deletedAt/deletedById; bytes are purged by the SERVICE first. */
export async function purgeDocumentMetadata(
  workspaceId: Types.ObjectId,
  documentId: Types.ObjectId,
  deletedById: Types.ObjectId,
): Promise<void> {
  const filter = {
    ...tenantFilter(workspaceId),
    _id: documentId,
    deletedAt: null,
  };
  assertTenantScope(filter, 'purgeDocumentMetadata');
  const result = await DocumentFileModel.updateOne(
    filter,
    { $set: { deletedAt: new Date(), deletedById } },
  );
  if (result.modifiedCount !== 1) {
    // Concurrent delete lost the race — the row left the live set while we
    // worked. A 404 (no second purge, no audit) is the honest resolution.
    throw AppError.notFound('Document not found');
  }
}

export async function countDocumentsInWorkspace(workspaceId: Types.ObjectId): Promise<number> {
  const filter = tenantFilter(workspaceId);
  assertTenantScope(filter, 'countDocumentsInWorkspace');
  return DocumentFileModel.countDocuments(filter);
}
