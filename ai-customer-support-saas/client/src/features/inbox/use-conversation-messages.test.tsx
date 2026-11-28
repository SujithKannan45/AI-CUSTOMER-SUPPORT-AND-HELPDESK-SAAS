import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpApiError } from '@/services/http-client.service';
import {
  makeMessage,
  makeMessageList,
  TEST_CONVERSATION_ID,
  TEST_MESSAGE_ID,
  TEST_SECOND_MESSAGE_ID,
} from '@/test/fixtures';
import { inboxService } from './inbox.service';
import type { MessageListPayload } from './types';
import { useConversationMessages } from './use-conversation-messages';

const WS = '507f1f77bcf86cd799439012';
const OTHER_WS = '507f1f77bcf86cd799439099';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useConversationMessages', () => {
  it('loads a short thread with a single request and no earlier page', async () => {
    const list = vi
      .spyOn(inboxService, 'listMessages')
      .mockResolvedValue(makeMessageList([makeMessage()], { total: 1 }));

    const { result } = renderHook(() => useConversationMessages(WS, TEST_CONVERSATION_ID));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.hasEarlier).toBe(false);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(
      WS,
      TEST_CONVERSATION_ID,
      { page: 1, limit: 50 },
      expect.any(AbortSignal),
    );
  });

  it('opens a long thread at its newest page instead of the oldest', async () => {
    const list = vi
      .spyOn(inboxService, 'listMessages')
      .mockImplementation((_ws, _id, query): Promise<MessageListPayload> => {
        if (query?.page === 1) {
          return Promise.resolve(
            makeMessageList([makeMessage({ id: TEST_MESSAGE_ID, body: 'oldest' })], {
              page: 1,
              total: 120,
              hasMore: true,
            }),
          );
        }
        return Promise.resolve(
          makeMessageList([makeMessage({ id: TEST_SECOND_MESSAGE_ID, body: 'newest' })], {
            page: 3,
            total: 120,
            hasMore: false,
          }),
        );
      });

    const { result } = renderHook(() => useConversationMessages(WS, TEST_CONVERSATION_ID));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.messages.map((message) => message.body)).toEqual(['newest']);
    expect(result.current.hasEarlier).toBe(true);
    expect(list.mock.calls.map((call) => call[2]?.page)).toEqual([1, 3]);
  });

  it('prepends the previous page and keeps chronological order', async () => {
    const earlier = makeMessage({
      id: TEST_MESSAGE_ID,
      body: 'earlier',
      createdAt: '2026-09-05T10:00:00.000Z',
    });
    const newer = makeMessage({
      id: TEST_SECOND_MESSAGE_ID,
      body: 'later',
      createdAt: '2026-09-05T11:00:00.000Z',
    });

    const list = vi
      .spyOn(inboxService, 'listMessages')
      .mockImplementation((_ws, _id, query) => {
        if (query?.page === 1) {
          return Promise.resolve(
            makeMessageList([earlier], { page: 1, total: 60, hasMore: true }),
          );
        }
        return Promise.resolve(
          makeMessageList([newer], { page: 2, total: 60, hasMore: false }),
        );
      });

    const { result } = renderHook(() => useConversationMessages(WS, TEST_CONVERSATION_ID));
    await waitFor(() => {
      expect(result.current.messages.map((message) => message.body)).toEqual(['later']);
    });

    act(() => {
      result.current.loadEarlier();
    });

    await waitFor(() => {
      expect(result.current.messages.map((message) => message.body)).toEqual(['earlier', 'later']);
    });
    expect(result.current.hasEarlier).toBe(false);
    expect(list).toHaveBeenLastCalledWith(WS, TEST_CONVERSATION_ID, { page: 1, limit: 50 });
  });

  it('never renders a previous workspace thread after a scope change', async () => {
    let resolveFirst: (value: Awaited<ReturnType<typeof inboxService.listMessages>>) => void = () => undefined;

    vi.spyOn(inboxService, 'listMessages').mockImplementation((workspaceId) => {
      if (workspaceId === WS) {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(
        makeMessageList([makeMessage({ body: 'second workspace message' })], { total: 1 }),
      );
    });

    const { result, rerender } = renderHook(
      ({ workspaceId, conversationId }: { workspaceId: string; conversationId: string }) =>
        useConversationMessages(workspaceId, conversationId),
      { initialProps: { workspaceId: WS, conversationId: TEST_CONVERSATION_ID } },
    );

    rerender({ workspaceId: OTHER_WS, conversationId: TEST_CONVERSATION_ID });

    await waitFor(() => {
      expect(result.current.messages.map((message) => message.body)).toEqual([
        'second workspace message',
      ]);
    });

    // The first workspace's late response arrives after the switch.
    act(() => {
      resolveFirst(
        makeMessageList([makeMessage({ body: 'stale first workspace message' })], { total: 1 }),
      );
    });

    await waitFor(() => {
      expect(result.current.messages.map((message) => message.body)).toEqual([
        'second workspace message',
      ]);
    });
  });

  it('ignores a malformed conversation id without requesting the API', () => {
    const list = vi.spyOn(inboxService, 'listMessages');

    const { result } = renderHook(() => useConversationMessages(WS, 'not-an-id'));

    expect(result.current.status).toBe('invalid');
    expect(result.current.messages).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });

  it('stays idle without a workspace', () => {
    const list = vi.spyOn(inboxService, 'listMessages');

    const { result } = renderHook(() => useConversationMessages(null, TEST_CONVERSATION_ID));

    expect(result.current.status).toBe('idle');
    expect(list).not.toHaveBeenCalled();
  });

  it('reports a read error without inventing messages', async () => {
    vi.spyOn(inboxService, 'listMessages').mockRejectedValue(
      new HttpApiError('raw server detail', { status: 403, code: 'FORBIDDEN' }),
    );

    const { result } = renderHook(() => useConversationMessages(WS, TEST_CONVERSATION_ID));

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.forbidden).toBe(true);
    expect(result.current.messages).toEqual([]);
    expect(result.current.error).not.toContain('raw server detail');
  });

  it('appends a sent message once, in order, and ignores duplicates', async () => {
    vi.spyOn(inboxService, 'listMessages').mockResolvedValue(
      makeMessageList([makeMessage({ body: 'first' })], { total: 1 }),
    );

    const { result } = renderHook(() => useConversationMessages(WS, TEST_CONVERSATION_ID));
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    const sent = makeMessage({
      id: TEST_SECOND_MESSAGE_ID,
      body: 'sent reply',
      createdAt: '2026-09-05T12:00:00.000Z',
    });

    act(() => {
      result.current.appendMessage(sent);
      result.current.appendMessage(sent);
    });

    expect(result.current.messages.map((message) => message.body)).toEqual(['first', 'sent reply']);
  });
});
