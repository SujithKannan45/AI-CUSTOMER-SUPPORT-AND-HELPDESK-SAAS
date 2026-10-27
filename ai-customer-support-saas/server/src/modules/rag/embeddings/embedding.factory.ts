import { env } from '../../../config/env.config.js';

import type { EmbeddingProvider } from './embedding-provider.interface.js';
import { MockEmbeddingProvider } from './mock-embedding.provider.js';
import { OpenAiEmbeddingProvider } from './openai-embedding.provider.js';

/**
 * Embedding provider selector — the ONLY place that decides how vectors are
 * produced. Mirrors the storage factory pattern (Prompt 12):
 *
 * - `none` (default): returns null — indexing/retrieval services surface a
 *   clear "not configured" operational error instead of pretending.
 * - `openai`: OpenAI-compatible adapter; requires OPENAI_API_KEY (production
 *   additionally boot-guards it in env.config.ts).
 * - `mock`: deterministic test/dev vectors; production boot REFUSES it.
 */
let cached: EmbeddingProvider | null | undefined;
let testOverride: EmbeddingProvider | null | undefined;

/** Test seam only: verification drivers inject fakes/stubs explicitly. */
export function setEmbeddingProviderForTests(provider: EmbeddingProvider | null | undefined): void {
  testOverride = provider;
}

export function getEmbeddingProvider(): EmbeddingProvider | null {
  if (testOverride !== undefined) return testOverride;
  if (cached === undefined) {
    switch (env.RAG_EMBEDDING_PROVIDER) {
      case 'openai':
        if (env.OPENAI_API_KEY === undefined) {
          // A missing key is a CONFIGURATION error at use time: index/retrieve
          // calls fail loudly with a clear code rather than crashing boot for
          // half-configured dev machines.
          cached = null;
          break;
        }
        cached = new OpenAiEmbeddingProvider({ apiKey: env.OPENAI_API_KEY });
        break;
      case 'mock':
        cached = new MockEmbeddingProvider(env.RAG_EMBEDDING_DIMENSIONS);
        break;
      case 'none':
      default:
        cached = null;
        break;
    }
  }
  return cached;
}

export function resetEmbeddingProviderForTests(): void {
  cached = undefined;
  testOverride = undefined;
}
