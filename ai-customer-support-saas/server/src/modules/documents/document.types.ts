import type { Types } from 'mongoose';

import type { TenantScopedDocument } from '../../database/tenant.js';

/**
 * Document/file domain vocabulary (Prompt 12) — the domain contract;
 * document.model.ts is the persistence boundary. Same split as kb.types.ts.
 *
 * Design center: file BYTES never live in MongoDB — the model carries metadata
 * and processing state only, and bytes live behind the StorageService seam
 * (local disk in development, S3 in production).
 */

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Upload/processing lifecycle of one file asset:
 *
 *   PENDING ──claim──▶ PROCESSING ──▶ COMPLETED   (bytes stored + text extracted)
 *        \                 │
 *         └────────────────┴──▶ FAILED        (storage or extraction error)
 *
 * - PENDING: metadata persisted, bytes persisted, extraction queued
 *   in-process (no job runner exists yet — the BullMQ phase owns retries).
 * - FAILED is TERMINAL for this prompt; POST /files/:id/reprocess re-arms a
 *   FAILED (or COMPLETED) document through PROCESSING again.
 * - Stranded PENDING/PROCESSING (process crash mid-extraction) is documented
 *   behavior: reprocess is the operator repair path until the jobs phase.
 */
export const DOCUMENT_STATUSES = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/**
 * Extraction sub-state, independent of the storage half of the lifecycle:
 * COMPLETED/SKIPPED/FAILED — SKIPPED is reserved for uploads that by policy
 * never yield text. Errors are stored as SAFE data ({code, message}): the
 * message never carries provider stack traces or file content.
 */
export const DOCUMENT_EXTRACTION_STATUSES = ['PENDING', 'COMPLETED', 'SKIPPED', 'FAILED'] as const;
export type DocumentExtractionStatus = (typeof DOCUMENT_EXTRACTION_STATUSES)[number];

export interface DocumentExtractionError {
  readonly code: string;
  /** Safe, user-displayable message; never an internal/provider detail. */
  readonly message: string;
}

// ── Media registry (allowlist — the entire upload surface) ────────────────────

/** Extraction-relevant content families. */
export type DocumentMediaType =
  | 'text/plain'
  | 'text/markdown'
  | 'text/csv'
  | 'application/json'
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

interface MediaTypePolicy {
  readonly mime: string;
  /** Canonical extension used for the composed storage key. */
  readonly extension: string;
  /** First bytes that MUST be present for binary families (content sniffing). */
  readonly magic?: readonly number[];
  /** Max bytes fed to the extractor (binary families are hot to parse). */
  readonly extractableFromBytes: boolean;
}

/**
 * The upload allowlist — a closed registry, not a denylist. Hex file-types,
 * HTML and unlabeled binaries are structurally 415 at upload. Each family's
 * `magic` (when present) is verified against the actual bytes; a declared-but-
 * unmatchable type is rejected as a content/label mismatch, which is how
 * disguised uploads are stopped without trusting client content types.
 */
export const DOCUMENT_MEDIA_TYPES: Record<DocumentMediaType, MediaTypePolicy> = {
  'text/plain': { mime: 'text/plain', extension: 'txt', extractableFromBytes: true },
  'text/markdown': { mime: 'text/markdown', extension: 'md', extractableFromBytes: true },
  'text/csv': { mime: 'text/csv', extension: 'csv', extractableFromBytes: true },
  'application/json': { mime: 'application/json', extension: 'json', extractableFromBytes: true },
  'application/pdf': {
    mime: 'application/pdf',
    extension: 'pdf',
    magic: [0x25, 0x50, 0x44, 0x46], // "%PDF-"
    extractableFromBytes: true,
  },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx',
    magic: [0x50, 0x4b, 0x03, 0x04], // ZIP local-file header (OOXML contract)
    extractableFromBytes: true,
  },
};

export const DOCUMENT_MEDIA_TYPE_LIST = Object.keys(DOCUMENT_MEDIA_TYPES) as DocumentMediaType[];

export function isDocumentMediaType(value: string): value is DocumentMediaType {
  return Object.prototype.hasOwnProperty.call(DOCUMENT_MEDIA_TYPES, value);
}

// ── Bounds (shared by document.model.ts and document.validation.ts) ───────────

export const DOCUMENT_FILENAME_MAX = 200;
/** Cap on metadata fields like change notes… (none yet) — reserved. */
export const MAX_DOCUMENT_PAGE_SIZE = 50;
export const MAX_DOCUMENT_SEARCH_LENGTH = 100;
/**
 * Bounded derived TEXT stored in MongoDB (NOT the raw file). 100k chars keeps
 * a document far below the 16 MiB BSON ceiling even before indexes; longer
 * extractions are truncated with `extractedTextTruncated: true` until the
 * chunking phase (Prompts 13–15) moves ingestion onto the storage seam.
 */
export const DOCUMENT_EXTRACTED_TEXT_MAX = 100_000;

// ── Document ──────────────────────────────────────────────────────────────────

/**
 * FileAsset — one uploaded file inside a workspace.
 *
 * Tenant-scoped like every other collection (`TenantScopedDocument`):
 * - storageKey/server-composed (UUID + canonical extension) — the client never
 *   supplies it, so no client value ever reaches a filesystem path;
 * - checksumSha256 enables future dedupe/integrity work without enforcing a
 *   duplicate-upload rule today (multiple uploads of the same file are legal);
 * - deletedAt is terminal metadata after a DELETE purges the stored bytes;
 *   the default query hook hides purged rows exactly like KB categories' live
 *   hook (opt-in withArchive-style scope for the delete internals).
 */
export interface DocumentFile extends TenantScopedDocument {
  /** User-sent filename, sanitized (no path fragments/control chars), metadata only. */
  originalFilename: string;
  /** Storage-provider key composed server-side; never client-supplied. */
  storageKey: string;
  /** Canonical sniffed/validated MIME from DOCUMENT_MEDIA_TYPES. */
  mediaType: 'text/plain' | 'text/markdown' | 'text/csv' | 'application/json' | 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  sizeBytes: number;
  /** Provider name as stored by the driver ('local' | bucket name). */
  storageProvider: string;
  checksumSha256: string;
  status: DocumentStatus;
  extractionStatus: DocumentExtractionStatus;
  extractionError: DocumentExtractionError | null;
  /** Bounded derived text (NOT the file bytes); null until COMPLETED/SKIPPED. */
  extractedText: string | null;
  extractedTextTruncated: boolean;
  /** Optional KB article attach-point (validated against the SAME workspace). */
  articleId: Types.ObjectId | null;
  uploadedById: Types.ObjectId;
  /** Set when DELETE completes; bytes are purged, the row stays for audit. */
  deletedAt: Date | null;
  deletedById: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}
