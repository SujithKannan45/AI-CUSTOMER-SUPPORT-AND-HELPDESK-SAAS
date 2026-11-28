import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { describeReadError } from '@/features/shared/errors';
import { ticketService } from './ticket.service';
import type {
  TicketListPayload,
  TicketListQuery,
  TicketPriority,
  TicketSortField,
  TicketStatus,
} from './types';

export type TicketListStatus = 'idle' | 'loading' | 'refreshing' | 'ready' | 'error';

export interface TicketListFilters {
  /** Already debounced by the page. */
  readonly search: string;
  readonly status: TicketStatus | '';
  readonly priority: TicketPriority | '';
  readonly page: number;
  readonly limit: number;
  /** Server allowlist field; defaults to `createdAt` (newest tickets first). */
  readonly sort?: TicketSortField;
  readonly order?: 'asc' | 'desc';
}

export interface TicketListState {
  readonly status: TicketListStatus;
  readonly data: TicketListPayload | null;
  readonly error: string | null;
  readonly forbidden: boolean;
  readonly workspaceId: string | null;
  readonly refresh: () => void;
}

interface InternalState {
  status: TicketListStatus;
  data: TicketListPayload | null;
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

function toQuery(filters: TicketListFilters): TicketListQuery {
  return {
    page: filters.page,
    limit: filters.limit,
    sort: filters.sort ?? 'createdAt',
    order: filters.order ?? 'desc',
    ...(filters.search.length > 0 ? { search: filters.search } : {}),
    ...(filters.status !== '' ? { status: filters.status } : {}),
    ...(filters.priority !== '' ? { priority: filters.priority } : {}),
  };
}

/**
 * Loads one page of tickets for the active workspace.
 *
 * Same tenant-safety contract as `useCustomers`: keyed on workspace + query,
 * data cleared synchronously on a scope change, responses applied only while
 * their request sequence is latest, superseded requests aborted.
 */
export function useTickets({
  workspaceId,
  filters,
}: {
  readonly workspaceId: string | null;
  readonly filters: TicketListFilters;
}): TicketListState {
  // Memoized on primitive values so an unchanged query keeps a stable identity.
  const { search, status, priority, page, limit, sort, order } = filters;
  const query = useMemo(
    () => toQuery({ search, status, priority, page, limit, sort, order }),
    [search, status, priority, page, limit, sort, order],
  );
  const queryKey = JSON.stringify(query);

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
        const payload = await ticketService.list(workspaceId, query, controller.signal);
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

        const description = describeReadError(error, 'tickets');
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
