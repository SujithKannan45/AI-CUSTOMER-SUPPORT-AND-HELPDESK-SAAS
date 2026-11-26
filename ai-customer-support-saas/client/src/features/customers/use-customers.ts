import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { describeReadError } from '@/features/shared/errors';
import { customerService } from './customer.service';
import type {
  CustomerArchiveState,
  CustomerListPayload,
  CustomerListQuery,
  CustomerStatus,
} from './types';

export type CustomerListStatus = 'idle' | 'loading' | 'refreshing' | 'ready' | 'error';

export interface CustomerListFilters {
  /** Already debounced by the page. */
  readonly search: string;
  readonly status: CustomerStatus | '';
  readonly archiveState: CustomerArchiveState;
  readonly page: number;
  readonly limit: number;
}

export interface CustomerListState {
  readonly status: CustomerListStatus;
  readonly data: CustomerListPayload | null;
  readonly error: string | null;
  readonly forbidden: boolean;
  /** Workspace the rendered data (or failure) belongs to. */
  readonly workspaceId: string | null;
  readonly refresh: () => void;
}

interface InternalState {
  status: CustomerListStatus;
  data: CustomerListPayload | null;
  error: string | null;
  forbidden: boolean;
  workspaceId: string | null;
  queryKey: string | null;
}

const INITIAL_STATE: InternalState = {
  status: 'idle',
  data: null,
  error: null,
  forbidden: false,
  workspaceId: null,
  queryKey: null,
};

/** Query object restricted to the fields the filters actually drive. */
function toQuery(filters: CustomerListFilters): CustomerListQuery {
  return {
    page: filters.page,
    limit: filters.limit,
    archiveState: filters.archiveState,
    sort: 'createdAt',
    order: 'desc',
    ...(filters.search.length > 0 ? { search: filters.search } : {}),
    ...(filters.status !== '' ? { status: filters.status } : {}),
  };
}

function queryKeyOf(query: CustomerListQuery): string {
  return JSON.stringify(query);
}

/**
 * Loads one page of customers for the active workspace.
 *
 * Tenant safety follows the Prompt 21 pattern: the hook is keyed on
 * `workspaceId` + the normalized query. A workspace or filter change clears the
 * previous rows immediately (a synchronous scope guard prevents even one frame
 * of another tenant's data), and every response is accepted only while its
 * request sequence is still the latest — an older workspace/page response can
 * never overwrite the current one.
 *
 * `AbortController` cancels superseded requests as a best-effort optimization;
 * the sequence guard is the correctness mechanism.
 */
export function useCustomers({
  workspaceId,
  filters,
}: {
  readonly workspaceId: string | null;
  readonly filters: CustomerListFilters;
}): CustomerListState {
  // Memoized on the primitive filter values (not the caller's object literal),
  // so an unchanged query keeps a stable identity and cannot re-trigger the
  // effect on every render.
  const { search, status, archiveState, page, limit } = filters;
  const query = useMemo(
    () => toQuery({ search, status, archiveState, page, limit }),
    [search, status, archiveState, page, limit],
  );
  const queryKey = queryKeyOf(query);

  const [reloadToken, setReloadToken] = useState(0);
  const [state, setState] = useState<InternalState>(INITIAL_STATE);
  const requestSeq = useRef(0);

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    if (workspaceId === null) {
      requestSeq.current += 1;
      setState(INITIAL_STATE);
      return;
    }

    const seq = ++requestSeq.current;
    const controller = new AbortController();

    setState((previous) => {
      const sameScope = previous.workspaceId === workspaceId && previous.queryKey === queryKey;

      if (sameScope && previous.data !== null) {
        return { ...previous, status: 'refreshing', error: null, forbidden: false };
      }

      return {
        status: 'loading',
        data: null,
        error: null,
        forbidden: false,
        workspaceId,
        queryKey,
      };
    });

    void (async () => {
      try {
        const payload = await customerService.list(workspaceId, query, controller.signal);
        if (seq !== requestSeq.current || controller.signal.aborted) return;

        setState({
          status: 'ready',
          data: payload,
          error: null,
          forbidden: false,
          workspaceId,
          queryKey,
        });
      } catch (error) {
        if (seq !== requestSeq.current || controller.signal.aborted) return;

        const description = describeReadError(error, 'customers');
        setState({
          status: 'error',
          data: null,
          error: description.message,
          forbidden: description.forbidden,
          workspaceId,
          queryKey,
        });
      }
    })();

    return () => {
      controller.abort();
    };
  }, [workspaceId, query, queryKey, reloadToken]);

  const scopeIsCurrent =
    workspaceId !== null && state.workspaceId === workspaceId && state.queryKey === queryKey;
  const staleScope = !scopeIsCurrent && (state.data !== null || state.status === 'error');
  const visible: InternalState =
    workspaceId === null || staleScope
      ? {
          ...state,
          status: workspaceId === null ? 'idle' : 'loading',
          data: null,
          error: null,
          forbidden: false,
        }
      : state;

  return {
    status: visible.status,
    data: visible.data,
    error: visible.error,
    forbidden: visible.forbidden,
    workspaceId: visible.workspaceId,
    refresh,
  };
}
