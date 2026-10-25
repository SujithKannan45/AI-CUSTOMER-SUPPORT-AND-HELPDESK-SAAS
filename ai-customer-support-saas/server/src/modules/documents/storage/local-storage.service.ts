import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AppError } from '../../../core/errors/app-error.js';

import type {
  PresignedUpload,
  PutObjectInput,
  StorageObject,
  StorageService,
} from './storage.service.interface.js';

/**
 * Local disk storage driver (development default; production therefore
 * REQUIRES `STORAGE_ALLOW_LOCAL_PRODUCTION=true`, the explicit boot decision
 * documented in env.config.ts).
 *
 * Key discipline: keys are COMPOSED by the document service (namespace-shaped
 * `workspaces/{workspaceId}/files/{uuid}.{ext}`) and this driver re-validates
 * the shape before touching the filesystem, so traversal can only ever fail
 * loudly — never silently escape the data directory.
 */
export class LocalStorageService implements StorageService {
  private readonly root: string;

  public constructor(dataDir: string) {
    this.root = path.resolve(dataDir);
  }

  /** Key shape guard — anything outside the document-module namespace is a bug. */
  private static isValidKey(key: string): boolean {
    return /^workspaces\/[a-f\d]{24}\/files\/[a-f\d-]+\.[a-z0-9]{1,10}$/i.test(key);
  }

  /** Absolute path of an object; throws (never resolves) on invalid keys. */
  private resolve(key: string): string {
    if (!LocalStorageService.isValidKey(key)) {
      throw new AppError(`Invalid storage key: ${key}`, {
        statusCode: 500,
        code: 'STORAGE_INVALID_KEY',
        isOperational: false,
      });
    }
    return path.join(this.root, key);
  }

  public async putObject(input: PutObjectInput): Promise<StorageObject> {
    const target = this.resolve(input.key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, input.body);
    return {
      key: input.key,
      bucket: 'local',
      size: input.body.byteLength,
      contentType: input.contentType,
    };
  }

  public async getObject(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  public async deleteObject(key: string): Promise<void> {
    try {
      await unlink(this.resolve(key));
    } catch (error: unknown) {
      const code = (error as { code?: unknown } | null)?.['code'];
      if (code === 'ENOENT') return; // Idempotent delete: already gone is gone.
      throw error;
    }
  }

  /**
   * The document module streams local bytes through the authenticated
   * download endpoint instead, so local "presigned" URLs would be a fake
   * Authenticity promise — they throw. S3 (the production driver) honors
   * these methods for real.
   */
  private static unsupportedError(): AppError {
    return new AppError('The local storage driver does not support presigned URLs', {
      statusCode: 501,
      code: 'LOCAL_PRESIGN_UNSUPPORTED',
    });
  }

  public createPresignedDownload(): Promise<string> {
    return Promise.reject(LocalStorageService.unsupportedError());
  }

  public createPresignedUpload(_input: {
    workspaceId: string;
    fileName: string;
    contentType: string;
  }): Promise<PresignedUpload> {
    return Promise.reject(LocalStorageService.unsupportedError());
  }
}
