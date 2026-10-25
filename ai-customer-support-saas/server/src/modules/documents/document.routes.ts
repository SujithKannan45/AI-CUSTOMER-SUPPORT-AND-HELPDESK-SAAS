import { type NextFunction, type Request, type Response , Router } from 'express';
import multer from 'multer';

import { env } from '../../config/env.config.js';
import { AppError } from '../../core/errors/app-error.js';
import { createRateLimiter } from '../../core/middlewares/rate-limiter.middleware.js';
import { validate } from '../../core/middlewares/validate.middleware.js';
import { requireAuth } from '../auth/require-auth.middleware.js';
import { WORKSPACE_PERMISSIONS } from '../rbac/rbac.permissions.js';
import { requirePermission } from '../rbac/require-permission.middleware.js';
import { requireWorkspaceContext } from '../workspaces/require-workspace.middleware.js';

import {
  deleteDocumentController,
  downloadDocumentController,
  getDocumentController,
  listDocumentsController,
  reprocessDocumentController,
  uploadDocumentController,
} from './document.controller.js';
import {
  documentParamSchema,
  listDocumentsQuerySchema,
  uploadFieldsSchema,
} from './document.validation.js';

/**
 * Document/file routes — mounted at `/api/v1/workspaces/:workspaceId/files`.
 *
 * Gate order per route (identical to the KB module):
 *
 *   1. requireAuth                            → 401
 *   2. validate(schema, 'params'|'query')     → 422
 *   3. requireWorkspaceContext()              → 404 (foreign/inactive concealed)
 *   4. requirePermission(...)                 → 403 (registry decision + audit)
 *
 * Permission mapping (centralized registry — no competing grants):
 * - `document.view` (owner/admin/agent): read file metadata, extracted text
 *   and download bytes. Deliberately NOT granted to viewer: file corpora and
 *   their extraction output are internal working material, not the read-only
 *   business record “viewing a ticket/repository” means.
 * - `document.manage` (owner/admin/agent): upload, reprocess, delete. Agents
 *   work the desk and attach evidence documents; that is the point of the
 *   module (note: agents handle ONLY documents they can legitimately
 *   reference — the extraction pipeline keeps documents workspace-scoped like
 *   every other resource).
 *
 * Uploads are multipart, memory-buffered (size-capped via multer limits from
 * env). A dedicated upload limiter protects the memory-expensive path: 30
 * uploads/minute/IP — far tighter than the global backstop.
 */

const uploadLimiter = createRateLimiter({ windowMs: 60_000, limit: 30 });

const requireWorkspace = requireWorkspaceContext();
const requireDocumentView = requirePermission(WORKSPACE_PERMISSIONS.viewDocuments);
const requireDocumentManage = requirePermission(WORKSPACE_PERMISSIONS.manageDocuments);

const uploadHandler = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.FILE_UPLOAD_MAX_BYTES,
    files: 1,
  },
}).single('file');

/** Translates multer's callback errors into the central error pipeline. */
function multipartUpload(req: Request, res: Response, next: NextFunction): void {
  uploadHandler(req, res, (error: unknown) => {
    if (error !== null && error !== undefined) {
      if (error instanceof multer.MulterError) {
        switch (error.code) {
          case 'LIMIT_FILE_SIZE':
            next(
              new AppError(`File exceeds the ${Math.floor(env.FILE_UPLOAD_MAX_BYTES / (1024 * 1024))} MB upload limit`, {
                statusCode: 413,
                code: 'FILE_TOO_LARGE',
              }),
            );
            return;
          case 'LIMIT_FILE_COUNT':
          case 'LIMIT_UNEXPECTED_FILE':
            next(AppError.validation('Send exactly one file under the "file" field'));
            return;
          default:
            next(AppError.validation(`File upload rejected (${error.code})`));
            return;
        }
      }
      // Busboy (inside multer) surfaces a truncated/corrupt multipart body as
      // a plain Error — that is a malformed REQUEST, not a server fault, so it
      // maps to 422 instead of surfacing as a 500.
      if (error instanceof Error && error.message === 'Unexpected end of form') {
        next(AppError.validation('Malformed multipart body'));
        return;
      }
      next(error as Error);
      return;
    }
    next();
  });
}

export const documentRouter = Router({ mergeParams: true });

// Upload carries a DEDICATED limiter BEFORE the shared gates (memory abuse is
// the threat this route uniquely adds).
documentRouter.post(
  '/files',
  requireAuth,
  uploadLimiter,
  multipartUpload,
  // Post-multer strict validation of the multipart TEXT fields (mass-
  // assignment protection: unknown form fields are a 422).
  validate(uploadFieldsSchema),
  requireWorkspace,
  requireDocumentManage,
  uploadDocumentController,
);

documentRouter.get(
  '/files',
  requireAuth,
  validate(listDocumentsQuerySchema, 'query'),
  requireWorkspace,
  requireDocumentView,
  listDocumentsController,
);

documentRouter.get(
  '/files/:fileId',
  requireAuth,
  validate(documentParamSchema, 'params'),
  requireWorkspace,
  requireDocumentView,
  getDocumentController,
);

documentRouter.get(
  '/files/:fileId/download',
  requireAuth,
  validate(documentParamSchema, 'params'),
  requireWorkspace,
  requireDocumentView,
  downloadDocumentController,
);

documentRouter.post(
  '/files/:fileId/reprocess',
  requireAuth,
  validate(documentParamSchema, 'params'),
  requireWorkspace,
  requireDocumentManage,
  reprocessDocumentController,
);

documentRouter.delete(
  '/files/:fileId',
  requireAuth,
  validate(documentParamSchema, 'params'),
  requireWorkspace,
  requireDocumentManage,
  deleteDocumentController,
);
