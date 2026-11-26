import { useCallback, useEffect, useRef, useState } from 'react';
import { describeReadError } from '@/features/shared/errors';
import { isObjectId } from '@/utils/object-id.util';
import { ticketService } from './ticket.service';
import type { TicketDto } from './types';

export type TicketDetailStatus = 'idle' | 'invalid' | 'loading' | 'ready' | 'not-found' | 'error';

export interface TicketDetailState {
  readonly status: TicketDetailStatus;
  readonly ticket: TicketDto | null;
  readonly error: string | null;
  readonly forbidden: boolean;
  readonly refresh: () => void;
}

interface InternalState {
  status: TicketDetailStatus;
  ticket: TicketDto | null;
  error: string | null;
  forbidden: boolean;
  workspaceId: string | null;
  ticketId: string | null;
}

const INITIAL_STATE: InternalState = {
  status: 'idle',
  ticket: null,
  error: null,
  forbidden: false,
  workspaceId: null,
  ticketId: null,
};

/**
 * Loads one ticket for the active workspace.
 *
 * Malformed ids are rejected locally without a request; unknown or foreign
 * ids resolve to the server's tenant-scoped 404 (`not-found`). The sequence
 * guard plus workspace/id keying prevents a previous tenant's ticket from being
 * shown after a workspace switch.
 */
export function useTicketDetail(
  workspaceId: string | null,
  ticketId: string | undefined,
): TicketDetailState {
  const [reloadToken, setReloadToken] = useState(0);
  const [state, setState] = useState<InternalState>(INITIAL_STATE);
  const requestSeq = useRef(0);

  const idIsValid = isObjectId(ticketId);

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    if (workspaceId === null || ticketId === undefined || !idIsValid) {
      requestSeq.current += 1;
      setState({
        ...INITIAL_STATE,
        status: workspaceId === null ? 'idle' : 'invalid',
        workspaceId,
        ticketId: ticketId ?? null,
      });
      return;
    }

    const seq = ++requestSeq.current;
    const controller = new AbortController();

    setState((previous) => {
      const sameScope = previous.workspaceId === workspaceId && previous.ticketId === ticketId;
      if (sameScope && previous.ticket !== null) {
        return { ...previous, error: null, forbidden: false };
      }
      return {
        status: 'loading',
        ticket: null,
        error: null,
        forbidden: false,
        workspaceId,
        ticketId,
      };
    });

    void (async () => {
      try {
        const payload = await ticketService.get(workspaceId, ticketId, controller.signal);
        if (seq !== requestSeq.current || controller.signal.aborted) return;

        setState({
          status: 'ready',
          ticket: payload.ticket,
          error: null,
          forbidden: false,
          workspaceId,
          ticketId,
        });
      } catch (error) {
        if (seq !== requestSeq.current || controller.signal.aborted) return;

        const description = describeReadError(error, 'ticket');
        setState({
          status: description.notFound ? 'not-found' : 'error',
          ticket: null,
          error: description.message,
          forbidden: description.forbidden,
          workspaceId,
          ticketId,
        });
      }
    })();

    return () => {
      controller.abort();
    };
  }, [workspaceId, ticketId, idIsValid, reloadToken]);

  const scopeIsCurrent =
    state.workspaceId === workspaceId && state.ticketId === (ticketId ?? null);
  const staleScope = !scopeIsCurrent && (state.ticket !== null || state.status === 'error');

  if (workspaceId === null) {
    return { status: 'idle', ticket: null, error: null, forbidden: false, refresh };
  }
  if (!idIsValid) {
    return { status: 'invalid', ticket: null, error: null, forbidden: false, refresh };
  }
  if (staleScope) {
    return { status: 'loading', ticket: null, error: null, forbidden: false, refresh };
  }

  return {
    status: state.status,
    ticket: state.ticket,
    error: state.error,
    forbidden: state.forbidden,
    refresh,
  };
}
