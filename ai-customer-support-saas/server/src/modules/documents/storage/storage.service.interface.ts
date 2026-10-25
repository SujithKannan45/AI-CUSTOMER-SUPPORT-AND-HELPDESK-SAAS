import { z } from 'zod';

/**
 * Document/file storage contract — the SAME seam the architecture doc claims
 * ("feature code depends only on StorageService"): the document module depends
 * on this shape only, so the implementation can be local disk in development
 * and S3 in production without touching feature code.
 *
 * Two interaction styles are supported ON PURPOSE:
 * - `putObject`/`getObject`/`deleteObject` — server-mediated flows. The
 *   document module uses these (upload passes through the server so it can
 *   checksum/sanitize/detect, extraction re-reads the bytes).
 * - `createPresignedUpload`/`createPresignedDownload` — direct browser↔S3
 *   flows reserved for a later direct-upload phase (unused by Prompt 12's
 *   server-mediated uploads).
 */
export const storageObjectSchema = z.object({
  key: z.string().min(1),
  bucket: z.string().min(1),
  size: z.number().int().nonnegative(),
  contentType: z.string().min(1),
});

export type StorageObject = z.infer<typeof storageObjectSchema>;

export interface PresignedUpload {
  readonly url: string;
  readonly key: string;
  /** Seconds until the presigned URL expires. */
  readonly expiresIn: number;
}

export interface PutObjectInput {
  /** Storage key — the persistence layer NEVER accepts client-composed keys. */
  readonly key: string;
  readonly body: Buffer;
  readonly contentType: string;
}

export interface StorageService {
  /** Persist bytes server-side; resolves with the stored-object descriptor. */
  putObject(input: PutObjectInput): Promise<StorageObject>;
  /** Read the full object back (document sizes are bounded by the upload cap). */
  getObject(key: string): Promise<Buffer>;
  /** Presigned expiring download URL (S3-style providers; local driver streams instead). */
  createPresignedDownload(key: string, expiresInSeconds?: number): Promise<string>;
  /** Presigned direct upload (unused by server-mediated Prompt 12 flows). */
  createPresignedUpload(input: { workspaceId: string; fileName: string; contentType: string }): Promise<PresignedUpload>;
  /** Remove bytes. Missing objects are treated as already-deleted (idempotent). */
  deleteObject(key: string): Promise<void>;
}
