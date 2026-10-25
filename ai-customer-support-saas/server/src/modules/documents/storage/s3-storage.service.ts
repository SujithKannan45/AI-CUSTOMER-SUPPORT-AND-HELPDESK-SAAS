import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { env, isProduction } from '../../../config/env.config.js';

import type {
  PresignedUpload,
  PutObjectInput,
  StorageObject,
  StorageService,
} from './storage.service.interface.js';

/**
 * S3 storage driver — the production driver. Constructed only when
 * `STORAGE_PROVIDER=s3`; env.config.ts' boot guard guarantees the region,
 * credentials and bucket are present before this class is ever reached.
 *
 * NOT exercised by the verification drivers (they run the local driver): the
 * path below is exercised in production/staging with real bucket credentials.
 * This limitation is called out in the docs rather than papered over with a
 * fake in-memory "S3".
 */
export class S3StorageService implements StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  public constructor(client: S3Client, bucket: string) {
    this.client = client;
    this.bucket = bucket;
  }

  public static fromEnv(): S3StorageService {
    if (
      env.S3_BUCKET_DOCUMENTS === undefined ||
      env.AWS_REGION === undefined ||
      env.AWS_ACCESS_KEY_ID === undefined ||
      env.AWS_SECRET_ACCESS_KEY === undefined
    ) {
      throw new Error(
        'STORAGE_PROVIDER=s3 requires AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and S3_BUCKET_DOCUMENTS.',
      );
    }
    return new S3StorageService(
      new S3Client({
        region: env.AWS_REGION,
        credentials: {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        },
      }),
      env.S3_BUCKET_DOCUMENTS,
    );
  }

  public async putObject(input: PutObjectInput): Promise<StorageObject> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        // Server-side encryption is the production durability contract.
        ...(isProduction ? { ServerSideEncryption: 'aws:kms' } : {}),
      }),
    );
    return {
      key: input.key,
      bucket: this.bucket,
      size: input.body.byteLength,
      contentType: input.contentType,
    };
  }

  public async getObject(key: string): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const body = result.Body;
    if (!body) throw new Error(`S3 object ${key} has an empty body`);
    return Buffer.from(await body.transformToByteArray());
  }

  public async deleteObject(key: string): Promise<void> {
    // DeleteObject is idempotent in S3 (deleting a missing key succeeds).
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  public async createPresignedDownload(key: string, expiresInSeconds = 300): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  public async createPresignedUpload(input: {
    workspaceId: string;
    fileName: string;
    contentType: string;
  }): Promise<PresignedUpload> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: `workspaces/${input.workspaceId}/files/${input.fileName}`,
      ContentType: input.contentType,
    });
    return {
      url: await getSignedUrl(this.client, command, { expiresIn: 600 }),
      key: `workspaces/${input.workspaceId}/files/${input.fileName}`,
      expiresIn: 600,
    };
  }
}
