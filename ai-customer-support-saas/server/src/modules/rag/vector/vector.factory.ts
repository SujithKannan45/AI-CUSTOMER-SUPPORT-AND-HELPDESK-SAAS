import { env } from '../../../config/env.config.js';

import { AtlasVectorStore } from './atlas-vector.store.js';
import { InMemoryVectorStore } from './in-memory-vector.store.js';
import type { VectorStore } from './vector-store.interface.js';

/**
 * Vector store selector — the ONLY place the app decides how similarity
 * search executes. Mirrors the storage/embedding factories:
 *
 * - `none` (default at boot): null — retrieval surfaces a clear
 *   "not configured" operational error; nothing pretends.
 * - `atlas`: production mode, requires an Atlas Search index (see the
 *   adapter and the architecture doc).
 * - `inmemory`: tests/dev only; refused in production by the env boot guard
 *   unless explicitly forced. Note this store is usable WITHOUT Atlas only
 *   because the operational math is in-process; vectors still live in Mongo.
 */
let cached: VectorStore | null | undefined;
let testOverride: VectorStore | null | undefined;

/** Test seam only: verification drivers inject determinism. */
export function setVectorStoreForTests(store: VectorStore | null | undefined): void {
  testOverride = store;
}

export function getVectorStore(): VectorStore | null {
  if (testOverride !== undefined) return testOverride;
  if (cached === undefined) {
    switch (env.RAG_VECTOR_SEARCH) {
      case 'atlas':
        cached = new AtlasVectorStore(env.RAG_ATLAS_VECTOR_INDEX);
        break;
      case 'inmemory':
        cached = new InMemoryVectorStore();
        break;
      case 'none':
      default:
        cached = null;
        break;
    }
  }
  return cached;
}

export function resetVectorStoreForTests(): void {
  cached = undefined;
  testOverride = undefined;
}
