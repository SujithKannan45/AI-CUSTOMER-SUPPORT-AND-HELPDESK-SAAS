import { Schema, model } from 'mongoose';

import { RAG_CHUNK_SOURCE_TYPES, RAG_EMBEDDING_STATUSES, type RagChunkDocument } from './rag.types.js';

/**
 * Chunk persistence boundary — the ONLY module that registers the
 * `rag_chunks` collection (Prompt 13). Chunks carry TEXT plus their embedding
 * vector; they are always derived data of an eligible source and safe to
 * purge/rebuild wholesale (the source remains the authoritative record —
 * the same relationship files have to their extracted text).
 */

const ragChunkSchema = new Schema<RagChunkDocument>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: [true, 'Workspace reference is required'],
    },
    sourceType: {
      type: String,
      required: true,
      enum: RAG_CHUNK_SOURCE_TYPES,
    },
    sourceId: {
      type: Schema.Types.ObjectId,
      required: [true, 'Source reference is required'],
    },
    chunkIndex: {
      type: Number,
      required: [true, 'Chunk index is required'],
      min: 0,
    },
    text: {
      type: String,
      required: [true, 'Chunk text is required'],
    },
    textLength: {
      type: Number,
      required: true,
      min: 1,
    },
    textHash: {
      type: String,
      required: [true, 'Chunk content hash is required'],
    },
    sourceHash: {
      type: String,
      required: [true, 'Source content hash is required'],
    },
    embeddingStatus: {
      type: String,
      enum: RAG_EMBEDDING_STATUSES,
      default: 'PENDING',
      required: true,
    },
    embeddingModel: { type: String, default: null },
    embeddingDimensions: { type: Number, default: null },
    embeddingError: {
      type: {
        code: { type: String, required: true },
        message: { type: String, required: true },
      },
      default: null,
    },
    embedding: { type: [Number], default: null },
    sourceEligible: {
      type: Boolean,
      default: true,
      required: true,
    },
  },
  { timestamps: true },
);

/**
 * The reindex idempotency LAW: one chunk per position per source per
 * workspace. Reindexes upsert against this key, so a lost race or repeated
 * manual indexing can never duplicate passages.
 */
ragChunkSchema.index(
  { workspaceId: 1, sourceType: 1, sourceId: 1, chunkIndex: 1 },
  { name: 'idx_rag_chunks_position_unique', unique: true },
);
/** Chunk-level content-hash lookups (dedupe forensics, future migration tools). */
ragChunkSchema.index({ workspaceId: 1, textHash: 1 }, { name: 'idx_rag_chunks_by_text_hash' });
/** Failed-embeddings work queue (status repair via reindex). */
ragChunkSchema.index(
  { workspaceId: 1, embeddingStatus: 1, sourceType: 1 },
  { name: 'idx_rag_chunks_by_status' },
);
/** Eligibility-scoped counts (“how much of the corpus is retrievable right now”). */
ragChunkSchema.index(
  { workspaceId: 1, sourceType: 1, sourceEligible: 1 },
  { name: 'idx_rag_chunks_by_eligibility' },
);
/** Source-hash lookup used by the reindex short-circuit (“did the source change”). */
ragChunkSchema.index({ workspaceId: 1, sourceId: 1, sourceHash: 1 }, { name: 'idx_rag_chunks_by_source_hash' });

export const RagChunkModel = model<RagChunkDocument>('RagChunk', ragChunkSchema, 'rag_chunks');
