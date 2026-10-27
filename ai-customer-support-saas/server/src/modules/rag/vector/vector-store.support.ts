import type { FilterQuery, Types } from 'mongoose';

import { tenantFilter } from '../../../database/tenant.js';
import type { RagChunkDocument } from '../rag.types.js';

/**
 * Shared retrieval eligibility predicate — the conditions BOTH vector-store
 * adapters apply INSIDE their query (isolation law):
 *
 * - workspace scope (tenantFilter — ObjectId-normalized, index-hitting);
 * - sourceEligible (denormalized live-source flag, maintained by the
 *   indexing lifecycle — no join back to the source at query time);
 * - embedding COMPLETED with the EXACT configured dimensionality, so vectors
 *   from a changed embedding space never silently participate in a search
 *   they cannot belong to.
 */
export function retrievalEligibilityFilter(
  workspaceId: Types.ObjectId,
  dimensions: number,
): FilterQuery<RagChunkDocument> {
  const filter: Record<string, unknown> = {
    ...tenantFilter(workspaceId),
    sourceEligible: true,
    embeddingStatus: 'COMPLETED',
    embeddingDimensions: dimensions,
  };
  return filter;
}

/** Cosine similarity in [-1, 1] between two equal-length numeric vectors. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return -1;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  const clamped = Math.min(1, Math.max(-1, dot / denominator));
  return clamped;
}
