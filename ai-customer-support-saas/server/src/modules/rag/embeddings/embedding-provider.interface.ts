import { z } from 'zod';

/**
 * Embedding provider abstraction — the seam between the RAG pipeline and any
 * vector-embedding service. Feature code depends ONLY on this interface; the
 * OpenAI adapter is an implementation detail, and the deterministic mock
 * provider exists SOLELY for tests/development (production boots refuse it —
 * see env.config.ts).
 *
 * Validation law (enforced by every adapter): the returned vectors MUST be
 * finite numbers, ordered like the input batch, and exactly as long as the
 * configured dimensionality — a provider that returns wrong-shaped vectors is
 * a hard failure, never a silent index corruption.
 */

export const EMBEDDING_PROVIDER_NAMES = ['openai', 'mock'] as const;
export type EmbeddingProviderName = (typeof EMBEDDING_PROVIDER_NAMES)[number];

/** Stable machine codes surfaced in SERVER LOGS and stored SAFE errors only. */
export type EmbeddingErrorCode =
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_TIMEOUT'
  | 'EMBEDDING_INVALID_RESPONSE'
  | 'EMBEDDING_DIMENSION_MISMATCH'
  | 'EMBEDDING_INPUT_INVALID';

export class EmbeddingProviderError extends Error {
  public readonly code: EmbeddingErrorCode;
  /** Retry-safe hint (a 429 after backoff is retryable; a 4xx payload rarely is). */
  public readonly retryable: boolean;

  public constructor(code: EmbeddingErrorCode, message: string, options?: {
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(message, { cause: options?.cause });
    this.name = new.target.name;
    this.code = code;
    this.retryable = options?.retryable ?? false;
  }
}

/** Strict shape every embedding payload must satisfy. */
export const embeddingVectorSchema = z.array(z.number().finite());
export type EmbeddingVector = z.infer<typeof embeddingVectorSchema>;

/** OpenAI-compatible embeddings response (validated with zod, never trusted). */
const openAiResponseSchema = z.object({
  data: z.array(z.object({ embedding: embeddingVectorSchema }).passthrough()),
});

export interface EmbeddingProvider {
  readonly name: EmbeddingProviderName;
  readonly model: string;
  readonly dimensions: number;
  /**
   * Embeds a batch of texts. Must preserve input order and return exactly one
   * vector per input. Callers validate batch-size bounds BEFORE calling.
   */
  embedBatch(texts: readonly string[]): Promise<readonly EmbeddingVector[]>;
}

/** Shared input validation used by both adapters (and unit-tested directly). */
export function validateEmbeddingBatchInput(
  texts: readonly string[],
  options: {
    readonly batchSize: number;
    readonly inputMaxChars: number;
  },
): readonly string[] {
  if (texts.length === 0) {
    throw new EmbeddingProviderError('EMBEDDING_INPUT_INVALID', 'The embedding batch is empty');
  }
  if (texts.length > options.batchSize) {
    throw new EmbeddingProviderError(
      'EMBEDDING_INPUT_INVALID',
      `The embedding batch exceeds ${options.batchSize} inputs`,
    );
  }
  return texts.map((text) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new EmbeddingProviderError('EMBEDDING_INPUT_INVALID', 'An embedding input is empty');
    }
    if (trimmed.length > options.inputMaxChars) {
      throw new EmbeddingProviderError(
        'EMBEDDING_INPUT_INVALID',
        `An embedding input exceeds ${options.inputMaxChars} characters`,
      );
    }
    return trimmed;
  });
}

/** Validated response-shape parser for the OpenAI-compatible payload. */
export function parseOpenAiEmbeddingResponse(payload: unknown): readonly EmbeddingVector[] {
  const parsed = openAiResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new EmbeddingProviderError(
      'EMBEDDING_INVALID_RESPONSE',
      'The embedding provider returned an unexpected response shape',
    );
  }
  return parsed.data.data.map((entry) => entry.embedding);
}

export interface EmbeddingProviderConfig {
  readonly model: string;
  readonly dimensions: number;
  readonly batchSize: number;
  readonly inputMaxChars: number;
  /** Dimension consistency check shared by adapters that need it. */
}

export function assertVectorDimensions(
  vectors: readonly EmbeddingVector[],
  expected: number,
): readonly EmbeddingVector[] {
  for (const vector of vectors) {
    if (vector.length !== expected) {
      throw new EmbeddingProviderError(
        'EMBEDDING_DIMENSION_MISMATCH',
        `The provider returned a ${vector.length}-dimension vector; ${expected} expected`,
      );
    }
  }
  return vectors;
}
