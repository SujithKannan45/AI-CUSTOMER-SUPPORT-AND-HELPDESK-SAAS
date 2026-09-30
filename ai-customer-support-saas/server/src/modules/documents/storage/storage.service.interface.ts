import { z } from 'zod';

/**
 * Document/file upload contract for the future S3 storage adapter.
 *
 * The rest of the app depends on this shape only, so the implementation can
 * start as S3 in production and a local disk driver in development without
 * changing feature code.
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

export interface StorageService {
  createPresignedUpload(input: { workspaceId: string; fileName: string; contentType: string }): Promise<PresignedUpload>;
  createPresignedDownload(key: string, expiresInSeconds?: number): Promise<string>;
  deleteObject(key: string): Promise<void>;
}
