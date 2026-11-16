import { z } from 'zod';

import { searchTermSchema } from '../../core/query/search-query.js';

import { SEARCH_ENTITY_TYPES, type SearchEntityType } from './search.types.js';

/**
 * Unified search request validation (Prompt 17).
 *
 * `.strict()` rejects every unknown query key, so unsupported entity types or
 * invented filters fail as 422 instead of being silently ignored. `q` is
 * REQUIRED (unified search is a query, not a browse endpoint) and bounded to
 * 100 characters by the shared search-term schema. `types` is a comma list
 * from the closed entity vocabulary; it can narrow the search surface but can
 * never widen authorization (the service still checks permissions per type).
 */

const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-f\d]{24}$/i, 'Must be a 24-character hex string');

export const searchWorkspaceParamsSchema = z
  .object({ workspaceId: objectIdSchema })
  .strict();

export interface SearchWorkspaceParams {
  readonly workspaceId: string;
}

/** Bounded preview size PER entity type (module endpoints own deep paging). */
export const MAX_SEARCH_PER_TYPE = 25;

const searchTypesSchema = z
  .string()
  .trim()
  .optional()
  .transform((raw) =>
    raw === undefined
      ? undefined
      : raw
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
  )
  .pipe(
    z
      .array(z.enum(SEARCH_ENTITY_TYPES))
      .min(1, 'Provide at least one entity type')
      .max(SEARCH_ENTITY_TYPES.length)
      .optional(),
  );

export const workspaceSearchQuerySchema = z
  .object({
    q: searchTermSchema(),
    types: searchTypesSchema,
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_SEARCH_PER_TYPE, `Per-type limit must be at most ${MAX_SEARCH_PER_TYPE}`)
      .default(10),
  })
  .strict();

export interface WorkspaceSearchQuery {
  readonly q: string;
  readonly types?: readonly SearchEntityType[];
  readonly limit: number;
}
