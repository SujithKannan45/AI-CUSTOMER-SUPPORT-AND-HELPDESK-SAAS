import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { describeReadError } from '@/features/shared/errors';
import { isObjectId } from '@/utils/object-id.util';
import { inboxService } from './inbox.service';
import { INBOX_MESSAGE_PAGE_SIZE, type MessageDto } from './types';

export type ConversationMessagesStatus = 'idle' | 'invalid' | 'loading' | 'ready' | 'error';

export interface ConversationMessagesState {
  readonly status: ConversationMessagesStatus;
  readonly messages: readonly MessageDto[];
  readonly error: string | null;
  readonly forbidden: boolean;
  /** Older messages exist before the loaded window. */
  readonly hasEarlier: boolean;
  readonly loadingEarlier: boolean;
  readonly loadEarlier: () => void;
  /** Adds a just-created message (id-deduplicated, ordered). */
  readonly appendMessage: (message: MessageDto) => void;
  readonly refresh: () => void;
}

interface InternalState {
  status: ConversationMessagesStatus;
  messages: MessageDto[];
  error: string | null;
  forbidden: boolean;
  page: number;
  hasEarlier: boolean;
  loadingEarlier: boolean;
  workspaceId: string | null;
  conversationId: string | null;
}

const INITIAL_STATE: InternalState = {
  status: 'idle',
  messages: [],
  error: null,
  forbidden: false,
  page: 1,
  hasEarlier: false,
  loadingEarlier: false,
  workspaceId: null,
  conversationId: null,
};

/** Stable chronological order (`createdAt`, then id) regardless of arrival order. */
function compareMessages(a: MessageDto, b: MessageDto): number {
  if (a.createdAt === b.createdAt) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return a.createdAt < b.createdAt ? -1 : 1;
}

/** Merges two already-ordered lists, dropping ids seen twice. */
function mergeMessages(
  existing: readonly MessageDto[],
  incoming: readonly MessageDto[],
): MessageDto[] {
  const byId = new Map<string, MessageDto>();
  for (const message of existing) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort(compareMessages);
}

/**
 * Loads one conversation's messages, newest window first.
 *
 * The API returns a chronological (ascending) page and its pagination is
 * server-side, so page 1 is the OLDEST page. A chat surface must open at the
 * newest messages: the hook therefore reads page 1 only to learn `total`, then
 * requests the LAST page. "Load earlier" walks backwards page by page, so a
 * long thread never re-downloads what is already rendered.
 *
 * Tenant safety: keyed on workspace + conversation, a request sequence rejects
 * late responses, requests are aborted on scope change, and the exposed state
 * never carries data from another scope.
 */
export function useConversationMessages(
  workspaceId: string | null,
  conversationId: string | null,
): ConversationMessagesState {
  const [reloadToken, setReloadToken] = useState(0);
  const [state, setState] = useState<InternalState>(INITIAL_STATE);
  const requestSeq = useRef(0);
  const earlierSeq = useRef(0);

  const idIsValid = conversationId !== null && isObjectId(conversationId);

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    if (workspaceId === null || conversationId === null || !idIsValid) {
      requestSeq.current += 1;
      earlierSeq.current += 1;
      setState({
        ...INITIAL_STATE,
        status: workspaceId === null ? 'idle' : 'invalid',
        workspaceId,
        conversationId,
      });
      return;
    }

    const seq = ++requestSeq.current;
    earlierSeq.current += 1;
    const controller = new AbortController();

    setState({
      status: 'loading',
      messages: [],
      error: null,
      forbidden: false,
      page: 1,
      hasEarlier: false,
      loadingEarlier: false,
      workspaceId,
      conversationId,
    });

    void (async () => {
      try {
        const first = await inboxService.listMessages(
          workspaceId,
          conversationId,
          { page: 1, limit: INBOX_MESSAGE_PAGE_SIZE },
          controller.signal,
        );
        if (seq !== requestSeq.current || controller.signal.aborted) return;

        if (!first.hasMore) {
          setState({
            status: 'ready',
            messages: mergeMessages([], first.items),
            error: null,
            forbidden: false,
            page: 1,
            hasEarlier: false,
            loadingEarlier: false,
            workspaceId,
            conversationId,
          });
          return;
        }

        // Long thread: open at the newest page instead of the oldest one.
        const lastPage = Math.max(1, Math.ceil(first.total / INBOX_MESSAGE_PAGE_SIZE));
        const newest =
          lastPage === 1
            ? first
            : await inboxService.listMessages(
                workspaceId,
                conversationId,
                { page: lastPage, limit: INBOX_MESSAGE_PAGE_SIZE },
                controller.signal,
              );
        if (seq !== requestSeq.current || controller.signal.aborted) return;

        setState({
          status: 'ready',
          messages: mergeMessages([], newest.items),
          error: null,
          forbidden: false,
          page: newest.page,
          hasEarlier: newest.page > 1,
          loadingEarlier: false,
          workspaceId,
          conversationId,
        });
      } catch (error) {
        if (seq !== requestSeq.current || controller.signal.aborted) return;

        const description = describeReadError(error, 'messages');
        setState({
          status: 'error',
          messages: [],
          error: description.message,
          forbidden: description.forbidden,
          page: 1,
          hasEarlier: false,
          loadingEarlier: false,
          workspaceId,
          conversationId,
        });
      }
    })();

    return () => {
      controller.abort();
    };
  }, [workspaceId, conversationId, idIsValid, reloadToken]);

  const loadEarlier = useCallback(() => {
    if (workspaceId === null || conversationId === null) return;

    const targetPage = state.page - 1;
    if (!state.hasEarlier || state.loadingEarlier || targetPage < 1) return;

    const requestToken = ++earlierSeq.current;
    setState((previous) => ({ ...previous, loadingEarlier: true }));

    void (async () => {
      try {
        const payload = await inboxService.listMessages(workspaceId, conversationId, {
          page: targetPage,
          limit: INBOX_MESSAGE_PAGE_SIZE,
        });
        if (requestToken !== earlierSeq.current) return;
        setState((previous) => {
          if (previous.workspaceId !== workspaceId || previous.conversationId !== conversationId) {
            return previous;
          }
          return {
            ...previous,
            messages: mergeMessages(previous.messages, payload.items),
            page: targetPage,
            hasEarlier: targetPage > 1,
            loadingEarlier: false,
          };
        });
      } catch (error) {
        if (requestToken !== earlierSeq.current) return;
        setState((previous) => ({
          ...previous,
          loadingEarlier: false,
          error: describeReadError(error, 'messages').message,
        }));
      }
    })();
  }, [
    workspaceId,
    conversationId,
    state.page,
    state.hasEarlier,
    state.loadingEarlier,
  ]);

  const appendMessage = useCallback(
    (message: MessageDto) => {
      setState((previous) => {
        // A message for another scope (late response after a switch) is dropped.
        if (
          previous.workspaceId !== workspaceId ||
          previous.conversationId !== conversationId
        ) {
          return previous;
        }
        return { ...previous, messages: mergeMessages(previous.messages, [message]) };
      });
    },
    [workspaceId, conversationId],
  );

  const scopeIsCurrent = state.workspaceId === workspaceId && state.conversationId === conversationId;

  const emptyState = useMemo<ConversationMessagesState>(
    () => ({
      status: workspaceId === null ? 'idle' : 'invalid',
      messages: [],
      error: null,
      forbidden: false,
      hasEarlier: false,
      loadingEarlier: false,
      loadEarlier,
      appendMessage,
      refresh,
    }),
    [workspaceId, loadEarlier, appendMessage, refresh],
  );

  if (workspaceId === null || !idIsValid) return emptyState;

  if (!scopeIsCurrent) {
    return {
      status: 'loading',
      messages: [],
      error: null,
      forbidden: false,
      hasEarlier: false,
      loadingEarlier: false,
      loadEarlier,
      appendMessage,
      refresh,
    };
  }

  return {
    status: state.status,
    messages: state.messages,
    error: state.error,
    forbidden: state.forbidden,
    hasEarlier: state.hasEarlier,
    loadingEarlier: state.loadingEarlier,
    loadEarlier,
    appendMessage,
    refresh,
  };
}
