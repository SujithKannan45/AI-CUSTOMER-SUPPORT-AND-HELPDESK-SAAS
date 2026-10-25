import { z } from 'zod';

import { DOCUMENT_EXTRACTION_STATUSES, DOCUMENT_STATUSES, MAX_DOCUMENT_PAGE_SIZE, MAX_DOCUMENT_SEARCH_LENGTH } from './document.types.js';

/**
 * Document request validation (Zod, applied declaratively at the routes) —
 * mirroring the models so HTTP failures are 422s and anything that slips past
 * is still caught at the persistence boundary.
 *
 * Upload payloads arrive as multipart/form-data, so `documentId`/`articleId`
 * TEXT FIELDS are validated SERVER-SIDE in the service (multer already
 * delivered them on req.body) — the strict-schema rule still holds: no client
 * value can ever carry workspaceId, uploadedById, storageKey, status,
 * extractionStatus or checksums, which are composed server-side only.
 */
export const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-f\d]{24}$/i, 'Must be a 24-character hex string');

// ── Identification ────────────────────────────────────────────────────────────

export const documentParamSchema = z
  .object({
    workspaceId: objectIdSchema,
    fileId: objectIdSchema,
  })
  .strict();

export interface DocumentParams {
  workspaceId: string;
  fileId: string;
}

export const workspaceParamSchema = z
  .object({
    workspaceId: objectIdSchema,
  })
  .strict();

// ── Pagination / filters ─────────────────────────────────────────────────────

export const listDocumentsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z
      .coerce
      .number()
      .int()
      .min(1)
      .max(MAX_DOCUMENT_PAGE_SIZE, `Page size must be at most ${MAX_DOCUMENT_PAGE_SIZE}`)
      .default(20),
    status: z.enum(DOCUMENT_STATUSES).optional(),
    extractionStatus: z.enum(DOCUMENT_EXTRACTION_STATUSES).optional(),
    articleId: objectIdSchema.optional(),
    search: z
      .string()
      .trim()
      .min(1)
      .max(MAX_DOCUMENT_SEARCH_LENGTH, `Search must be at most ${MAX_DOCUMENT_SEARCH_LENGTH} characters`)
      .optional(),
  })
  .strict();

export interface ListDocumentsQuery {
  page: number;
  limit: number;
  status?: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  extractionStatus?: 'PENDING' | 'COMPLETED' | 'SKIPPED' | 'FAILED';
  articleId?: string;
  search?: string;
}

/** Optional lifecycle/multipart bookkeeping the service accepts on uploads. */
export const uploadFieldsSchema = z
  .object({
    /** Optional Knowledge Base attach-point; validated against the SAME workspace. */
    articleId: objectIdSchema.optional(),
  })
  .strict();

export interface UploadFieldsInput {
  articleId?: string;
}
