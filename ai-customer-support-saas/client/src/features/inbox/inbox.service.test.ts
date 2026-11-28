import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpClient } from '@/services/http-client.service';
import {
  makeConversation,
  makeConversationList,
  makeMessage,
  makeMessageList,
  TEST_CONVERSATION_ID,
  TEST_TICKET_ID,
} from '@/test/fixtures';
import { inboxService, messageListSearch } from './inbox.service';

const WS = '507f1f77bcf86cd799439012';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('inboxService', () => {
  it('reads the primary conversation of one ticket with pagination', async () => {
    const get = vi.spyOn(httpClient, 'get').mockResolvedValue(makeConversationList());
    const controller = new AbortController();

    const payload = await inboxService.listForTicket(
      WS,
      TEST_TICKET_ID,
      { page: 1, limit: 1 },
      controller.signal,
    );

    expect(payload.items).toHaveLength(1);
    expect(get).toHaveBeenCalledWith(
      `/api/v1/workspaces/${WS}/tickets/${TEST_TICKET_ID}/conversations?page=1&limit=1`,
      { signal: controller.signal },
    );
  });

  it('starts a conversation with an empty create body', async () => {
    const post = vi
      .spyOn(httpClient, 'post')
      .mockResolvedValue({ conversation: makeConversation(), created: true });

    const payload = await inboxService.startForTicket(WS, TEST_TICKET_ID);

    expect(payload.created).toBe(true);
    expect(post).toHaveBeenCalledWith(
      `/api/v1/workspaces/${WS}/tickets/${TEST_TICKET_ID}/conversations`,
      {},
    );
  });

  it('reads one conversation by id', async () => {
    const get = vi
      .spyOn(httpClient, 'get')
      .mockResolvedValue({ conversation: makeConversation() });

    await inboxService.get(WS, TEST_CONVERSATION_ID);

    expect(get).toHaveBeenCalledWith(
      `/api/v1/workspaces/${WS}/conversations/${TEST_CONVERSATION_ID}`,
      {},
    );
  });

  it('lists messages with page, limit and optional search', async () => {
    const get = vi.spyOn(httpClient, 'get').mockResolvedValue(makeMessageList());

    await inboxService.listMessages(WS, TEST_CONVERSATION_ID, { page: 2, limit: 50 });
    expect(get).toHaveBeenLastCalledWith(
      `/api/v1/workspaces/${WS}/conversations/${TEST_CONVERSATION_ID}/messages?page=2&limit=50`,
      {},
    );

    await inboxService.listMessages(WS, TEST_CONVERSATION_ID, {
      page: 1,
      limit: 50,
      search: 'invoice',
    });
    expect(get).toHaveBeenLastCalledWith(
      `/api/v1/workspaces/${WS}/conversations/${TEST_CONVERSATION_ID}/messages?page=1&limit=50&search=invoice`,
      {},
    );
  });

  it('omits an empty search term instead of sending search=', () => {
    expect(messageListSearch({ page: 1, limit: 20, search: '' })).toBe('page=1&limit=20');
  });

  it('sends only body and visibility — identity fields stay server-side', async () => {
    const post = vi
      .spyOn(httpClient, 'post')
      .mockResolvedValue({ message: makeMessage({ visibility: 'INTERNAL' }) });

    const payload = await inboxService.sendMessage(WS, TEST_CONVERSATION_ID, {
      body: 'Customer cannot see this',
      visibility: 'INTERNAL',
    });

    expect(payload.message.visibility).toBe('INTERNAL');
    expect(post).toHaveBeenCalledWith(
      `/api/v1/workspaces/${WS}/conversations/${TEST_CONVERSATION_ID}/messages`,
      { body: 'Customer cannot see this', visibility: 'INTERNAL' },
    );
    const body = post.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(
      ['workspaceId', 'conversationId', 'ticketId', 'senderId', 'senderType'].filter(
        (key) => key in body,
      ),
    ).toEqual([]);
  });

  it('encodes ids so a crafted id cannot alter the request path', async () => {
    const get = vi.spyOn(httpClient, 'get').mockResolvedValue({ conversation: makeConversation() });

    await inboxService.get(WS, '../../auth/login');

    expect(get).toHaveBeenCalledWith(
      `/api/v1/workspaces/${WS}/conversations/..%2F..%2Fauth%2Flogin`,
      {},
    );
  });
});
