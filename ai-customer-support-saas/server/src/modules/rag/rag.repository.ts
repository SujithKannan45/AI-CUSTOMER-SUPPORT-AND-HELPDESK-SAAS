import type { Types } from 'mongoose';

import { assertTenantScope, tenantFilter } from '../../database/tenant.js';

import { RagChunkModel } from './rag.model.js';
import type {
  RagChunkDocument,
  RagChunkSourceType,
  RagEmbeddingError,
  RagEmbeddingStatus,
} from './rag.types.js';

/**
 * Chunk persistence layer — the ONLY module touching `rag_chunks` (same
 * contract as the other feature repositories):
 *
 * - EVERY query is built through `tenantFilter()` and defended with
 *   `assertTenantScope()`; source ids are composed into the filter here so a
 *   foreign source reads as not-found (no cross-tenant existence oracle).
 * - Writes are SCOPED bulk upserts/deletes keyed by the unique
 *   `{ workspaceId, sourceType, sourceId, chunkIndex }` index — never
 *   read-then-write on a global key.
 * - NO multi-document transactions exist in this deployment: the reindex
 *   path (upsert desired set, then delete obsolete) is a documented
 *   best-effort ordering — see the data-model doc for the failure narrative.
 */

export interface ChunkUpsertRecord {
  readonly chunkIndex: number;
  readonly text: string;
  readonly textLength: number;
  readonly textHash: string;
  readonly sourceHash: string;
  readonly embeddingStatus: RagEmbeddingStatus;
  readonly embeddingModel: string | null;
  readonly embeddingDimensions: number | null;
  readonly embeddingError: RagEmbeddingError | null;
  readonly embedding: readonly number[] | null;
}

export interface ReplaceSourceChunksPlan {
  /** Chunk indexes that no longer exist in the source — removed AFTER the upserts. */
  readonly removeIndexes: readonly number[];
  readonly upserts: readonly ChunkUpsertRecord[];
}

export interface ReplaceSourceChunksResult {
  readonly upserted: number;
  readonly deleted: number;
}

/** Upsert the desired chunk set against the position-unique index. */
export async function replaceSourceChunks(
  workspaceId: Types.ObjectId,
  sourceType: RagChunkSourceType,
  sourceId: Types.ObjectId,
  plan: ReplaceSourceChunksPlan,
): Promise<ReplaceSourceChunksResult> {
  let upserted = 0;
  if (plan.upserts.length > 0) {
    const operations = plan.upserts.map((chunk) => ({
      updateOne: {
        filter: {
          ...tenantFilter(workspaceId),
          sourceType,
          sourceId,
          chunkIndex: chunk.chunkIndex,
        },
        update: {
          $set: {
            text: chunk.text,
            textLength: chunk.textLength,
            textHash: chunk.textHash,
            sourceHash: chunk.sourceHash,
            embeddingStatus: chunk.embeddingStatus,
            embeddingModel: chunk.embeddingModel,
            embeddingDimensions: chunk.embeddingDimensions,
            embeddingError: chunk.embeddingError,
            embedding: chunk.embedding !== null ? [...chunk.embedding] : null,
            sourceEligible: true,
          },
        },
        upsert: true,
      },
    }));
    const result = await RagChunkModel.bulkWrite(operations, { ordered: false });
    upserted =
      result.upsertedCount +
      result.modifiedCount;
  }

  let deleted = 0;
  if (plan.removeIndexes.length > 0) {
    const filter = {
      ...tenantFilter(workspaceId),
      sourceType,
      sourceId,
      chunkIndex: { $in: [...plan.removeIndexes] },
    };
    assertTenantScope(filter, 'replaceSourceChunks/deleteObsolete');
    const result = await RagChunkModel.deleteMany(filter);
    deleted = result.deletedCount;
  }

  return { upserted, deleted };
}

export async function findSourceChunks(
  workspaceId: Types.ObjectId,
  sourceType: RagChunkSourceType,
  sourceId: Types.ObjectId,
): Promise<readonly RagChunkDocument[]> {
  const filter = {
    ...tenantFilter(workspaceId),
    sourceType,
    sourceId,
  };
  assertTenantScope(filter, 'findSourceChunks');
  return RagChunkModel.find(filter).sort({ chunkIndex: 1, _id: 1 });
}

/** Does ANY stored chunk of this source already carry this exact source hash? */
export async function hasSourceChunksWithHash(
  workspaceId: Types.ObjectId,
  sourceType: RagChunkSourceType,
  sourceId: Types.ObjectId,
  sourceHash: string,
): Promise<boolean> {
  const filter = {
    ...tenantFilter(workspaceId),
    sourceType,
    sourceId,
    sourceHash,
  };
  assertTenantScope(filter, 'hasSourceChunksWithHash');
  return (await RagChunkModel.exists(filter)) !== null;
}

export async function deleteSourceChunks(
  workspaceId: Types.ObjectId,
  sourceType: RagChunkSourceType,
  sourceId: Types.ObjectId,
): Promise<number> {
  const filter = { ...tenantFilter(workspaceId), sourceType, sourceId };
  assertTenantScope(filter, 'deleteSourceChunks');
  const result = await RagChunkModel.deleteMany(filter);
  return result.deletedCount;
}

/**
 * Marks every chunk of a source LOSING eligibility as non-retrievable while
 * KEEPING text and vectors — so a republish can re-eligibilize the
 * same chunks (and reuse their embeddings) with a single reindex instead of
 * a re-embed. Used by the article-unpublish trigger.
 */
export async function markSourceChunksIneligible(
  workspaceId: Types.ObjectId,
  sourceType: RagChunkSourceType,
  sourceId: Types.ObjectId,
): Promise<number> {
  const filter = {
    ...tenantFilter(workspaceId),
    sourceType,
    sourceId,
    sourceEligible: true,
  };
  assertTenantScope(filter, 'markSourceChunksIneligible');
  const result = await RagChunkModel.updateMany(filter, { $set: { sourceEligible: false } });
  return result.modifiedCount;
}

/**
 * The mirrored repair: marks every stored chunk of a source REGAINING
 * eligibility as retrievable again. Used by the indexing run's UNCHANGED
 * short-circuit — a republish after an unpublished window must flip the
 * denormalized flag back even though no content changed.
 */
export async function markSourceChunksEligible(
  workspaceId: Types.ObjectId,
  sourceType: RagChunkSourceType,
  sourceId: Types.ObjectId,
): Promise<number> {
  const filter = {
    ...tenantFilter(workspaceId),
    sourceType,
    sourceId,
    sourceEligible: false,
  };
  assertTenantScope(filter, 'markSourceChunksEligible');
  const result = await RagChunkModel.updateMany(filter, { $set: { sourceEligible: true } });
  return result.modifiedCount;
}

export interface ChunkListSpec {
  readonly workspaceId: Types.ObjectId;
  readonly page: number;
  readonly limit: number;
  readonly sourceType?: RagChunkSourceType;
  readonly sourceId?: Types.ObjectId;
  readonly embeddingStatus?: RagEmbeddingStatus;
}

export interface ChunkListResult {
  readonly items: readonly RagChunkDocument[];
  readonly total: number;
  readonly hasMore: boolean;
}

/** Management listing — TEXT is deliberately NOT projected (internal content). */
export async function listChunks(spec: ChunkListSpec): Promise<ChunkListResult> {
  const filter: Record<string, unknown> = { ...tenantFilter(spec.workspaceId) };
  assertTenantScope(filter, 'listChunks');
  if (spec.sourceType !== undefined) filter['sourceType'] = spec.sourceType;
  if (spec.sourceId !== undefined) filter['sourceId'] = spec.sourceId;
  if (spec.embeddingStatus !== undefined) filter['embeddingStatus'] = spec.embeddingStatus;

  const [items, total] = await Promise.all([
    RagChunkModel.find(filter)
      .select('-text -embedding')
      .sort({ sourceType: 1, sourceId: 1, chunkIndex: 1, _id: 1 })
      .skip((spec.page - 1) * spec.limit)
      .limit(spec.limit),
    RagChunkModel.countDocuments(filter),
  ]);

  return { items, total, hasMore: spec.page * spec.limit < total };
}

export interface RagStatusCounts {
  readonly total: number;
  readonly byEmbeddingStatus: Readonly<Record<RagEmbeddingStatus, number>>;
  readonly bySourceType: Readonly<Record<RagChunkSourceType, number>>;
  readonly eligible: number;
}

export async function chunkStatusCounts(workspaceId: Types.ObjectId): Promise<RagStatusCounts> {
  const filter = { ...tenantFilter(workspaceId) };
  assertTenantScope(filter, 'chunkStatusCounts');
  const groups = await RagChunkModel.aggregate<{ _id: { embeddingStatus?: string; sourceType?: string }; count: number }>([
    { $match: filter },
    {
      $group: {
        _id: { embeddingStatus: '$embeddingStatus', sourceType: '$sourceType' },
        count: { $sum: 1 },
      },
    },
  ]);

  const byEmbeddingStatus: Record<RagEmbeddingStatus, number> = {
    PENDING: 0,
    COMPLETED: 0,
    FAILED: 0,
  };
  const bySourceType = { KB_ARTICLE: 0, DOCUMENT: 0 } as Record<RagChunkSourceType, number>;
  let eligible = 0;

  const eligibility = await RagChunkModel.aggregate<{ eligible: number }>([
    { $match: { ...filter, sourceEligible: true } },
    { $group: { _id: null, eligible: { $sum: 1 } } },
  ]);

  let total = 0;
  for (const group of groups) {
    const count = group.count;
    total += count;
    if (group._id['embeddingStatus'] !== undefined) {
      byEmbeddingStatus[group._id['embeddingStatus'] as RagEmbeddingStatus] += count;
    }
    if (group._id['sourceType'] !== undefined) {
      bySourceType[group._id['sourceType'] as RagChunkSourceType] += count;
    }
  }
  eligible = eligibility[0]?.['eligible'] ?? 0;

  return {
    total,
    byEmbeddingStatus,
    bySourceType,
    eligible,
  };
}
