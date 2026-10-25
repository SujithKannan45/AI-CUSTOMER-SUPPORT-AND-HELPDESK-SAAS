import {
  Schema,
  model,
  type CallbackWithoutResultAndOptionalError,
  type Query,
} from 'mongoose';

import {
  DOCUMENT_EXTRACTED_TEXT_MAX,
  DOCUMENT_EXTRACTION_STATUSES,
  DOCUMENT_FILENAME_MAX,
  DOCUMENT_MEDIA_TYPES,
  DOCUMENT_STATUSES,
  type DocumentFile,
} from './document.types.js';

/**
 * File-asset persistence boundary — the ONLY module that registers the
 * `file_assets` collection (Prompt 12). Bytes are never stored here: only
 * metadata, checksum, lifecycle and processing state. Storage keys are not
 * even client-reachable (service-composed UUID + canonical extension), so no
 * client value ever flows into a provider path.
 */

const documentSchema = new Schema<DocumentFile>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: [true, 'Workspace reference is required'],
    },
    originalFilename: {
      type: String,
      required: [true, 'Filename is required'],
      trim: true,
      maxlength: DOCUMENT_FILENAME_MAX,
    },
    storageKey: {
      type: String,
      required: [true, 'Storage key is required'],
    },
    mediaType: {
      type: String,
      required: [true, 'Media type is required'],
      enum: Object.keys(DOCUMENT_MEDIA_TYPES),
    },
    sizeBytes: {
      type: Number,
      required: [true, 'File size is required'],
      min: 1,
    },
    storageProvider: {
      type: String,
      required: [true, 'Storage provider is required'],
    },
    checksumSha256: {
      type: String,
      required: [true, 'Checksum is required'],
    },
    status: {
      type: String,
      enum: DOCUMENT_STATUSES,
      default: 'PENDING',
      required: true,
    },
    extractionStatus: {
      type: String,
      enum: DOCUMENT_EXTRACTION_STATUSES,
      default: 'PENDING',
      required: true,
    },
    extractionError: {
      type: {
        code: { type: String, required: true },
        message: { type: String, required: true },
      },
      default: null,
    },
    extractedText: {
      type: String,
      default: null,
      maxlength: DOCUMENT_EXTRACTED_TEXT_MAX,
    },
    extractedTextTruncated: {
      type: Boolean,
      default: false,
    },
    articleId: {
      type: Schema.Types.ObjectId,
      ref: 'KnowledgeBaseArticle',
      default: null,
    },
    uploadedById: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Uploader reference is required'],
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    deletedById: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true },
);

/** Query option that bypasses the live-only scope (delete internals). */
interface DocumentQueryOptions {
  withPurged?: boolean;
}

/** Mirrors the KB categories / customers live-only default scope. */
documentSchema.pre(
  ['find', 'findOne', 'countDocuments'],
  function excludeDeletedDocuments(
    this: Query<unknown, DocumentFile>,
    next: CallbackWithoutResultAndOptionalError,
  ): void {
    const options = this.getOptions() as unknown as DocumentQueryOptions;
    if (options.withPurged !== true && this.getFilter().deletedAt === undefined) {
      this.where({ deletedAt: null });
    }
    next();
  },
);

/** Live-only scope bypass, same convention as KB_CATEGORY_WITH_ARCHIVE. */
export const DOCUMENT_WITH_PURGED = { withPurged: true } as const;

documentSchema.index(
  { workspaceId: 1, createdAt: -1 },
  { name: 'idx_file_assets_listing' },
);
documentSchema.index(
  { workspaceId: 1, status: 1, createdAt: -1 },
  { name: 'idx_file_assets_by_status' },
);
documentSchema.index(
  { workspaceId: 1, extractionStatus: 1, createdAt: -1 },
  { name: 'idx_file_assets_by_extraction' },
);
documentSchema.index(
  { workspaceId: 1, articleId: 1, createdAt: -1 },
  { name: 'idx_file_assets_by_article' },
);
documentSchema.index(
  { workspaceId: 1, uploadedById: 1, createdAt: -1 },
  { name: 'idx_file_assets_by_uploader' },
);
documentSchema.index(
  { workspaceId: 1, checksumSha256: 1 },
  { name: 'idx_file_assets_by_checksum' },
);

export const DocumentFileModel = model<DocumentFile>('DocumentFile', documentSchema, 'file_assets');
