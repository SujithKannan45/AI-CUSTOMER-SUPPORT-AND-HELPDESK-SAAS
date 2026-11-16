import type {
  SearchEntityType,
  WorkspaceSearchItemDto,
} from './search.types.js';

/**
 * Unified search read model.
 *
 * `searchedTypes` vs `skippedTypes` is deliberately explicit: a requested
 * entity the caller's role cannot read is OMITTED (never an error and never a
 * hint about whether matching records exist). Clients can render the
 * difference without inferring tenant/role information beyond their own
 * permission set.
 *
 * Pagination law: unified search is a bounded PREVIEW (≤ 25 per type). The
 * module endpoints remain the paginated authority; no cursor or deep paging
 * is offered here, so no `total`/`hasMore` is implied.
 */
export interface WorkspaceSearchPayload {
  readonly query: string;
  readonly requestedTypes: readonly SearchEntityType[];
  readonly searchedTypes: readonly SearchEntityType[];
  readonly skippedTypes: readonly SearchEntityType[];
  readonly perTypeLimit: number;
  /** Result count per searched entity type (0 included). */
  readonly counts: Record<string, number>;
  readonly items: readonly WorkspaceSearchItemDto[];
  readonly totalResults: number;
}
