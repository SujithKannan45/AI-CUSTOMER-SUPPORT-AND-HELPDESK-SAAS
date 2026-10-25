import type { Request, RequestHandler, Response } from 'express';

import { AppError } from '../../core/errors/app-error.js';
import { asyncHandler, sendSuccess } from '../../core/http/api-response.js';
import { resolveEffectiveRole } from '../rbac/require-permission.middleware.js';

import type { DocumentRequestContext } from './document.dto.js';
import {
  deleteDocumentFlow,
  getDocumentDownloadFlow,
  getDocumentFlow,
  listDocumentsFlow,
  reprocessDocumentFlow,
  uploadDocumentFlow,
} from './document.service.js';
import type { ListDocumentsQuery, UploadFieldsInput } from './document.validation.js';

/**
 * Document controllers — HTTP shape only (parse → service → respond).
 * Authorization has ALREADY happened in middleware:
 *
 *   requireAuth → validate(...) → requireWorkspaceContext() → requirePermission(...)
 *
 * The upload controller is the one place the boundary is different from the
 * other modules: the payload is multipart/form-data (multer in
 * document.routes.ts has already validated size/count BEFORE we run), so the
 * service receives the in-memory buffer and the validated text fields.
 */

export interface DocumentValidatedRequest extends Request {
  readonly validated?: {
    readonly params?: {
      readonly workspaceId?: string;
      readonly fileId?: string;
    };
  };
}

/** Shared actor-context builder (same contract as kbContextOf). */
function documentContextOf(req: DocumentValidatedRequest): DocumentRequestContext {
  const workspace = req.workspace!;
  return {
    workspaceId: workspace.workspaceId,
    actorId: req.auth!.userId,
    role: resolveEffectiveRole(workspace),
  };
}

function paramsOf(req: DocumentValidatedRequest): { readonly workspaceId: string; readonly fileId: string } {
  const params = req.validated!.params!;
  return { workspaceId: params.workspaceId!, fileId: params.fileId! };
}

/**
 * `Content-Disposition` with an ASCII fallback plus RFC 5987 encoding, so
 * non-ASCII filenames survive the header without injection (quotes/backslashes
 * are neutralized).
 */
function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function sendDownload(res: Response, payload: { readonly filename: string; readonly sizeBytes: number; readonly bytes: Buffer }): void {
  res.setHeader('content-type', 'application/octet-stream');
  res.setHeader('content-length', payload.sizeBytes);
  res.setHeader('content-disposition', attachmentDisposition(payload.filename));
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', 'no-store');
  res.status(200).end(payload.bytes);
}

/** POST …/files — multipart upload (field name `file`). */
export const uploadDocumentController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as DocumentValidatedRequest;
  const file = r.file;
  if (file === undefined) {
    throw AppError.validation('Send the file as multipart/form-data under the "file" field');
  }
  // validate(uploadFieldsSchema) has REPLACED req.body with the strict-validated
  // parsed form fields (mass-assignment already handled at the middleware).
  const fields = (req.body ?? {}) as UploadFieldsInput;
  sendSuccess(
    res,
    201,
    await uploadDocumentFlow(documentContextOf(r), file, fields),
    req,
  );
});

/** GET …/files — filtered/paginated metadata listing (no extracted text). */
export const listDocumentsController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as DocumentValidatedRequest;
  sendSuccess(
    res,
    200,
    await listDocumentsFlow(
      documentContextOf(r),
      req.query as unknown as ListDocumentsQuery,
    ),
    req,
  );
});

/** GET …/files/:fileId — detail incl. bounded extracted text. */
export const getDocumentController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as DocumentValidatedRequest;
  const { fileId } = paramsOf(r);
  sendSuccess(res, 200, await getDocumentFlow(documentContextOf(r), fileId), req);
});

/** GET …/files/:fileId/download — always-octet-stream attachment bytes. */
export const downloadDocumentController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as DocumentValidatedRequest;
  const { fileId } = paramsOf(r);
  const payload = await getDocumentDownloadFlow(documentContextOf(r), fileId);
  sendDownload(res, payload);
});

/** POST …/files/:fileId/reprocess — re-arm extraction (202). */
export const reprocessDocumentController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as DocumentValidatedRequest;
  const { fileId } = paramsOf(r);
  sendSuccess(res, 202, await reprocessDocumentFlow(documentContextOf(r), fileId), req);
});

/** DELETE …/files/:fileId — purge bytes, soft-stamp metadata (200 with id). */
export const deleteDocumentController: RequestHandler = asyncHandler(async (req, res) => {
  const r = req as DocumentValidatedRequest;
  const { fileId } = paramsOf(r);
  sendSuccess(res, 200, await deleteDocumentFlow(documentContextOf(r), fileId), req);
});
