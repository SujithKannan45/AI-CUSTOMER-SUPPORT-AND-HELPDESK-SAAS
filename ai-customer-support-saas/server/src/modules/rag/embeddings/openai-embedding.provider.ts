import { env } from '../../../config/env.config.js';

import {
  assertVectorDimensions,
  EmbeddingProviderError,
  type EmbeddingProvider,
  type EmbeddingVector,
  parseOpenAiEmbeddingResponse,
  validateEmbeddingBatchInput,
} from './embedding-provider.interface.js';

/**
 * OpenAI-compatible embedding adapter (Prompt 13).
 *
 * - Batches within the configured limits; a single bounded retry on
 *   transient failures (429/5xx) with a fixed backoff — systematic retry /
 *   backoff policy belongs to the BullMQ phase, this is only the in-call
 *   escape hatch so one burst of 429s doesn't fail a whole index run.
 * - Times out via AbortController (never hangs the indexing run).
 * - VALIDATES the response strictly: order-preserving, finite, exact
 *   dimensionality. Provider deviations are hard failures with safe codes.
 *
 * The adapter accepts an injectable fetch ONLY as a test seam (the verify
 * driver exercises malformed responses without network); production uses
 * global fetch.
 */

interface OpenAiAdapterOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly dimensions?: number;
  readonly batchSize?: number;
  readonly timeoutMs?: number;
  readonly inputMaxChars?: number;
  readonly fetchImpl?: typeof fetch;
  readonly retryDelayMs?: number;
}

const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  public readonly name = 'openai' as const;
  public readonly model: string;
  public readonly dimensions: number;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly inputMaxChars: number;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;

  public constructor(options: OpenAiAdapterOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? env.RAG_OPENAI_BASE_URL;
    this.model = options.model ?? env.RAG_EMBEDDING_MODEL;
    this.dimensions = options.dimensions ?? env.RAG_EMBEDDING_DIMENSIONS;
    this.batchSize = Math.min(options.batchSize ?? env.RAG_EMBEDDING_BATCH_SIZE, 2048);
    this.timeoutMs = options.timeoutMs ?? env.RAG_EMBEDDING_TIMEOUT_MS;
    this.inputMaxChars = options.inputMaxChars ?? env.RAG_EMBEDDING_INPUT_MAX_CHARS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryDelayMs = options.retryDelayMs ?? 500;
  }

  public async embedBatch(texts: readonly string[]): Promise<readonly EmbeddingVector[]> {
    const batch = validateEmbeddingBatchInput(texts, {
      batchSize: this.batchSize,
      inputMaxChars: this.inputMaxChars,
    });

    const vectors = await this.requestEmbeddings(batch);
    if (vectors.length !== batch.length) {
      throw new EmbeddingProviderError(
        'EMBEDDING_INVALID_RESPONSE',
        `The provider returned ${vectors.length} vectors for ${batch.length} inputs`,
      );
    }
    return assertVectorDimensions(vectors, this.dimensions);
  }

  private async requestEmbeddings(batch: readonly string[]): Promise<readonly EmbeddingVector[]> {
    try {
      const first = await this.postEmbeddings(batch);
      return parseOpenAiEmbeddingResponse(first);
    } catch (error: unknown) {
      // One bounded retry for transient shapes (rate limit / upstream 5xx /
      // timeout). Non-retryable provider deviations rethrow immediately.
      const typed = error as { code?: unknown; retryable?: unknown };
      const retryable = typed['retryable'] === true;
      const isTransientNetwork =
        error instanceof TypeError; // fetch network failure
      if (!retryable && !isTransientNetwork) throw error;
      await sleep(this.retryDelayMs);
      const second = await this.postEmbeddings(batch);
      return parseOpenAiEmbeddingResponse(second);
    }
  }

  private async postEmbeddings(batch: readonly string[]): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(new URL('/embeddings', this.baseUrl).toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: batch,
          dimensions: this.dimensions,
        }),
        signal: controller.signal,
      });
    } catch (error: unknown) {
      clearTimeout(timer);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new EmbeddingProviderError('PROVIDER_TIMEOUT', 'The embedding request timed out', {
          retryable: true,
          cause: error,
        });
      }
      // Network-level failure: caller decides on the retry, then this throws again.
      throw error;
    }
    clearTimeout(timer);

    if (!response.ok) {
      if (TRANSIENT_STATUS_CODES.has(response.status)) {
        throw new EmbeddingProviderError(
          response.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_UNAVAILABLE',
          `The embedding provider answered ${response.status}`,
          { retryable: true },
        );
      }
      // Auth/payload problems are deterministic: one message for all statuses
      // avoids leaking provider internals.
      throw new EmbeddingProviderError(
        'PROVIDER_UNAVAILABLE',
        'The embedding provider rejected the request',
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error: unknown) {
      throw new EmbeddingProviderError(
        'EMBEDDING_INVALID_RESPONSE',
        'The embedding provider returned malformed JSON',
        { cause: error },
      );
    }
    return payload;
  }
}
