import { env } from '../../../config/env.config.js';

import { LocalStorageService } from './local-storage.service.js';
import { S3StorageService } from './s3-storage.service.js';
import type { StorageService } from './storage.service.interface.js';

/**
 * Storage driver selector — the ONLY place the app decides where file bytes
 * live. `STORAGE_PROVIDER=local` (default, development) uses the disk driver;
 * `s3` uses the AWS SDK driver, whose credentials are boot-guarded in
 * env.config.ts. The driver is constructed once per process.
 */
let cached: StorageService | undefined;

export function getStorageService(): StorageService {
  if (cached === undefined) {
    cached =
      env.STORAGE_PROVIDER === 's3'
        ? S3StorageService.fromEnv()
        : new LocalStorageService(env.STORAGE_DATA_DIR);
  }
  return cached;
}

/** Test seam only: verification drivers rebuild the process, never swap drivers. */
export function resetStorageServiceForTests(): void {
  cached = undefined;
}
