import { createHash } from 'node:crypto';

import {
  type EmbeddingProvider,
  type EmbeddingVector,
  validateEmbeddingBatchInput,
} from './embedding-provider.interface.js';

/**
 * Deterministic mock embedding provider (Prompt 13) — tests/development ONLY.
 *
 * - Production environments refuse it at boot (env.config.ts guard), so no
 *   fake vectors can silently return "real" retrieval results in prod.
 * - Output derives from sha-256(text) through a seeded xorshift PRNG, so the
 *   same input ALWAYS yields the same unit vector across processes and runs —
 *   that determinism is what lets verification drivers assert whole
 *   retrieval/similarity flows without network credentials.
 * - Values are L2-normalized, so cosine similarity in the in-memory store
 *   behaves like a real geometric space.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  public readonly name = 'mock' as const;
  public readonly model = 'mock-hash-embedding';
  public readonly dimensions: number;

  public constructor(dimensions: number) {
    this.dimensions = dimensions;
  }

  public embedBatch(texts: readonly string[]): Promise<readonly EmbeddingVector[]> {
    // The mock reuses the same input guards so callers cannot take a code
    // path with a real provider that the tests never exercised.
    const batch = validateEmbeddingBatchInput(texts, {
      batchSize: 2048,
      inputMaxChars: 1_000_000,
    });
    return Promise.resolve(batch.map((text) => this.hashEmbedding(text)));
  }

  private hashEmbedding(text: string): EmbeddingVector {
    const seed = createHash('sha256').update(text, 'utf8').digest();
    const view = new DataView(seed.buffer, seed.byteOffset, seed.byteLength);
    let state = view.getUint32(0, false) || 0x9e3779b9;

    const next = (): number => {
      // xorshift32 — deterministic, tiny, adequate for a test vector space.
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state;
    };

    const raw: number[] = [];
    for (let i = 0; i < this.dimensions; i += 1) {
      if (i % 4 === 0 && i > 0) {
        state = (state + 0x6d2b79f5) >>> 0; // re-seed periodically from the digest
      }
      // Map uint32 → [-1, 1).
      raw.push((next() / 0x1_0000_0000) * 2 - 1);
    }
    const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0)) || 1;
    return raw.map((value) => value / norm);
  }
}
