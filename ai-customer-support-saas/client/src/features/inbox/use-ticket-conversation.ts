import { useCallback, useEffect, useRef, useState } from 'react';
import { describeMutationError, describeReadError } from '@/features/shared/errors';
import { isObjectId } from '@/utils/object-id.util';
import { inboxService } from './inbox.service';
import type { ConversationDto } from './types';

export type TicketConversationStatus = 'idle' | 'invalid' | 'loading' | 'ready' | 'none' | 'error';

export interface TicketConversationState {
  readonly status: TicketConversationStatus;
  readonly conversation: ConversationDto | null;
  readonly error: string | null;
  readonly forbidden: boolean;
  /** True while a get-or-create request is in flight. */
  readonly starting: boolean;
  readonly startError: string | null;
  readonly refresh: () => void;
  /** Materialises the ticket's primary conversation; resolves true on success. */
  readonly start: () => Promise<boolean>;
}

interface InternalState {
  status: TicketConversationStatus;
  conversation: ConversationDto | null;
  error: string | null;
  forbidden: boolean;
  starting: boolean;
  startError: string | null;
  workspaceId: string | null;
  ticketId: string | null;
}

const INITIAL_STATE: InternalState = {
  status: 'idle',
  conversation: null,
  error: null,
  forbidden: false,
  starting: false,
  startError: null,
  workspaceId: null,
  ticketId: null,
};

/**
 * Resolves the single primary conversation of one ticket.
 *
 * The backend has no workspace-wide conversation listing: a conversation is
 * read per ticket (`GET …/tickets/:id/conversations`, at most one item) and
 * created lazily by `POST …/tickets/:id/conversations`. A ticket that was never
 * messaged therefore resolves to `none` — the inbox shows an explicit "start
 * the conversation" action instead of inventing a thread.
 *
 * Tenant safety matches the other detail hooks: keyed on workspace + ticket, a
 * request sequence rejects late responses, superseded requests are aborted, and
 * state from another scope is never rendered.
 */
export function useTicketConversation(
  workspaceId: string | null,
  ticketId: string | null,
): TicketConversationState {
  const [reloadToken, setReloadToken] = useState(0);
  const [state, setState] = useState<InternalState>(INITIAL_STATE);
  const requestSeq = useRef(0);

  const idIsValid = ticketId !== null && isObjectId(ticketId);

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    if (workspaceId === null || ticketId === null || !idIsValid) {
      requestSeq.current += 1;
      setState({
        ...INITIAL_STATE,
        status: workspaceId === null ? 'idle' : 'invalid',
        workspaceId,
        ticketId,
      });
      return;
    }

    const seq = ++requestSeq.current;
    const controller = new AbortController();

    setState((previous) => {
      // A refresh of the SAME conversation keeps it on screen (no skeleton
      // flash, no composer remount) — only a scope change clears it.
      const sameScope =
        previous.workspaceId === workspaceId && previous.ticketId === ticketId;
      if (sameScope && previous.conversation !== null) {
        return { ...previous, status: 'ready', error: null, forbidden: false, startError: null };
      }
      return {
        status: 'loading',
        conversation: null,
        error: null,
        forbidden: false,
        starting: false,
        startError: null,
        workspaceId,
        ticketId,
      };
    });

    void (async () => {
      try {
        const payload = await inboxService.listForTicket(
          workspaceId,
          ticketId,
          { page: 1, limit: 1 },
          controller.signal,
        );
        if (seq !== requestSeq.current || controller.signal.aborted) return;

        const conversation = payload.items[0] ?? null;
        setState({
          status: conversation === null ? 'none' : 'ready',
          conversation,
          error: null,
          forbidden: false,
          starting: false,
          startError: null,
          workspaceId,
          ticketId,
        });
      } catch (error) {
        if (seq !== requestSeq.current || controller.signal.aborted) return;

        const description = describeReadError(error, 'conversation');
        setState({
          status: 'error',
          conversation: null,
          error: description.message,
          forbidden: description.forbidden,
          starting: false,
          startError: null,
          workspaceId,
          ticketId,
        });
      }
    })();

    return () => {
      controller.abort();
    };
  }, [workspaceId, ticketId, idIsValid, reloadToken]);

  const scopeIsCurrent = state.workspaceId === workspaceId && state.ticketId === ticketId;

  const start = useCallback(async (): Promise<boolean> => {
    if (workspaceId === null || ticketId === null) return false;
    // Guard against duplicate submissions: a second click while the first
    // request is in flight must not create a second conversation request.
    const seq = requestSeq.current;
    setState((previous) => ({ ...previous, starting: true, startError: null }));
    try {
      const payload = await inboxService.startForTicket(workspaceId, ticketId);
      if (seq !== requestSeq.current) return false;
      setState({
        status: 'ready',
        conversation: payload.conversation,
        error: null,
        forbidden: false,
        starting: false,
        startError: null,
        workspaceId,
        ticketId,
      });
      return true;
    } catch (error) {
      if (seq !== requestSeq.current) return false;
      setState((previous) => ({
        ...previous,
        starting: false,
        startError: describeMutationError(error, {
          fallback: 'The conversation could not be started. Please try again.',
          notFound: 'This ticket no longer exists in the current workspace, or was archived.',
        }),
      }));
      return false;
    }
  }, [workspaceId, ticketId]);

  if (workspaceId === null) {
    return {
      status: 'idle',
      conversation: null,
      error: null,
      forbidden: false,
      starting: false,
      startError: null,
      refresh,
      start,
    };
  }

  if (!idIsValid) {
    return {
      status: 'invalid',
      conversation: null,
      error: null,
      forbidden: false,
      starting: false,
      startError: null,
      refresh,
      start,
    };
  }

  if (!scopeIsCurrent) {
    return {
      status: 'loading',
      conversation: null,
      error: null,
      forbidden: false,
      starting: false,
      startError: null,
      refresh,
      start,
    };
  }

  return {
    status: state.status,
    conversation: state.conversation,
    error: state.error,
    forbidden: state.forbidden,
    starting: state.starting,
    startError: state.startError,
    refresh,
    start,
  };
}
