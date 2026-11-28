import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ToastProvider } from '@/app/providers/toast.provider';
import { analyticsService } from '@/features/analytics/analytics.service';
import { useSessionStore } from '@/features/auth/auth.store';
import { customerService } from '@/features/customers/customer.service';
import { inboxService } from '@/features/inbox/inbox.service';
import { ticketService } from '@/features/tickets/ticket.service';
import { useWorkspaceStore } from '@/features/workspace/workspace.store';
import { HttpApiError } from '@/services/http-client.service';
import {
  makeConversation,
  makeConversationList,
  makeCustomer,
  makeDashboardAnalytics,
  makeMessage,
  makeMessageList,
  makeTicket,
  makeTicketList,
  makeWorkspace,
  resetAuthStores,
  TEST_CONVERSATION_ID,
  TEST_SECOND_MESSAGE_ID,
  TEST_SECOND_TICKET_ID,
  TEST_TICKET_ID,
  TEST_USER,
} from '@/test/fixtures';
import type { WorkspaceRole } from '@/features/workspace/types';
import { InboxPage } from './inbox.page';

let listTickets: MockInstance<typeof ticketService.list>;
let listConversations: MockInstance<typeof inboxService.listForTicket>;
let listMessages: MockInstance<typeof inboxService.listMessages>;
let sendMessage: MockInstance<typeof inboxService.sendMessage>;
let startConversation: MockInstance<typeof inboxService.startForTicket>;
let getOverview: MockInstance<typeof analyticsService.getOverview>;

function setWorkspace(role: WorkspaceRole = 'owner'): void {
  useWorkspaceStore.setState({
    status: 'ready',
    items: [makeWorkspace('ws-1', 'Acme', role)],
    activeWorkspaceId: 'ws-1',
    error: null,
  });
}

function renderPage(): void {
  render(
    <ToastProvider>
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>
    </ToastProvider>,
  );
}

async function selectFirstConversation(): Promise<void> {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /Invoice shows the wrong total/ }));
}

describe('InboxPage', () => {
  beforeEach(() => {
    resetAuthStores();
    useSessionStore.setState({ status: 'authenticated', user: TEST_USER, error: null });
    setWorkspace();

    listTickets = vi.spyOn(ticketService, 'list').mockResolvedValue(
      makeTicketList([
        makeTicket(),
        makeTicket({
          id: TEST_SECOND_TICKET_ID,
          number: 'TKT-000002',
          subject: 'CSV upload crashes the importer',
          status: 'IN_PROGRESS',
          priority: 'URGENT',
        }),
      ]),
    );
    vi.spyOn(customerService, 'get').mockResolvedValue({ customer: makeCustomer() });
    listConversations = vi
      .spyOn(inboxService, 'listForTicket')
      .mockResolvedValue(makeConversationList([makeConversation()]));
    listMessages = vi
      .spyOn(inboxService, 'listMessages')
      .mockResolvedValue(makeMessageList([makeMessage()]));
    sendMessage = vi
      .spyOn(inboxService, 'sendMessage')
      .mockResolvedValue({
        message: makeMessage({
          id: TEST_SECOND_MESSAGE_ID,
          body: 'Reply stored by the server',
          createdAt: '2026-09-05T12:00:00.000Z',
        }),
      });
    startConversation = vi
      .spyOn(inboxService, 'startForTicket')
      .mockResolvedValue({ conversation: makeConversation(), created: true });
    getOverview = vi
      .spyOn(analyticsService, 'getOverview')
      .mockResolvedValue(makeDashboardAnalytics().overview);
  });

  it('lists the workspace conversations with real ticket fields', async () => {
    renderPage();

    const row = await screen.findByRole('button', { name: /Invoice shows the wrong total/ });
    expect(row).toHaveTextContent('TKT-000001');
    expect(row).toHaveTextContent('Open');
    expect(row).toHaveTextContent('High');
    expect(row).toHaveTextContent('Unassigned');
    // Two different counts: the list paginates tickets, the total is the
    // workspace's real conversation count.
    expect(screen.getByText('2 tickets')).toBeInTheDocument();
    expect(await screen.findByText('10 conversations in this workspace')).toBeInTheDocument();
    expect(screen.getByText(/Live updates unavailable/)).toBeInTheDocument();

    // The inbox orders by recent activity and reuses the ticket list contract.
    expect(listTickets).toHaveBeenCalledWith(
      'ws-1',
      { page: 1, limit: 20, sort: 'updatedAt', order: 'desc' },
      expect.any(AbortSignal),
    );
  });

  it('reads the conversation total from the workspace analytics overview', async () => {
    getOverview.mockResolvedValue({ ...makeDashboardAnalytics().overview });

    renderPage();

    expect(await screen.findByText('10 conversations in this workspace')).toBeInTheDocument();
    expect(getOverview).toHaveBeenCalledWith('ws-1', { range: '30d' }, expect.any(AbortSignal));
  });

  it('states the limitation instead of guessing when analytics is not readable', async () => {
    setWorkspace('agent');

    renderPage();

    expect(
      await screen.findByText('Conversation total requires workspace analytics access'),
    ).toBeInTheDocument();
    expect(screen.getByText('2 tickets')).toBeInTheDocument();
    expect(getOverview).not.toHaveBeenCalled();
  });

  it('degrades honestly when the conversation total cannot be loaded', async () => {
    getOverview.mockRejectedValue(new HttpApiError('boom', { status: 500, code: 'INTERNAL' }));

    renderPage();

    expect(await screen.findByText('Conversation total unavailable right now')).toBeInTheDocument();
    expect(screen.getByText('2 tickets')).toBeInTheDocument();
  });

  it('shows a loading state before the first page arrives', () => {
    listTickets.mockReturnValue(new Promise(() => undefined));

    renderPage();

    expect(screen.getByText('Loading conversations…')).toBeInTheDocument();
  });

  it('shows an empty state for a workspace without tickets', async () => {
    listTickets.mockResolvedValue(makeTicketList([], { total: 0 }));

    renderPage();

    expect(await screen.findByText('No conversations yet')).toBeInTheDocument();
  });

  it('renders a retryable error', async () => {
    const user = userEvent.setup();
    listTickets
      .mockRejectedValueOnce(new HttpApiError('boom', { status: 500, code: 'INTERNAL' }))
      .mockResolvedValue(makeTicketList());

    renderPage();

    expect(await screen.findByText('Inbox unavailable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('button', { name: /Invoice shows the wrong total/ })).toBeInTheDocument();
  });

  it('renders a non-retryable authorization state for a 403', async () => {
    listTickets.mockRejectedValue(new HttpApiError('forbidden', { status: 403, code: 'FORBIDDEN' }));

    renderPage();

    expect(await screen.findByText('Inbox access required')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('loads the selected conversation and its messages', async () => {
    renderPage();
    await selectFirstConversation();

    expect(await screen.findByText('Thanks for reaching out — checking the invoice now.')).toBeInTheDocument();
    expect(listConversations).toHaveBeenCalledWith(
      'ws-1',
      TEST_TICKET_ID,
      { page: 1, limit: 1 },
      expect.any(AbortSignal),
    );
    expect(listMessages).toHaveBeenCalledWith(
      'ws-1',
      TEST_CONVERSATION_ID,
      { page: 1, limit: 50 },
      expect.any(AbortSignal),
    );
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Invoice shows the wrong total/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('returns to the list from the conversation panel', async () => {
    const user = userEvent.setup();
    renderPage();
    await selectFirstConversation();
    await screen.findByText('Thanks for reaching out — checking the invoice now.');

    await user.click(screen.getByRole('button', { name: /back to conversation list/i }));

    expect(
      screen.getByRole('button', { name: /Invoice shows the wrong total/ }),
    ).not.toHaveAttribute('aria-current');
  });

  it('starts the conversation when a ticket has none yet', async () => {
    const user = userEvent.setup();
    listConversations.mockResolvedValue(makeConversationList([], { total: 0 }));

    renderPage();
    await selectFirstConversation();

    expect(await screen.findByText('No conversation yet')).toBeInTheDocument();
    expect(await screen.findByText('10 conversations in this workspace')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start conversation' }));

    await waitFor(() => {
      expect(startConversation).toHaveBeenCalledWith('ws-1', TEST_TICKET_ID);
    });
    expect(await screen.findByRole('textbox')).toBeInTheDocument();
    // Creating a conversation changes the workspace total, so it is re-read.
    await waitFor(() => {
      expect(getOverview).toHaveBeenCalledTimes(2);
    });
  });

  it('sends a public reply through the API and renders the server record', async () => {
    const user = userEvent.setup();
    renderPage();
    await selectFirstConversation();
    await screen.findByText('Thanks for reaching out — checking the invoice now.');

    await user.type(screen.getByRole('textbox'), 'We refunded order 8812.');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith('ws-1', TEST_CONVERSATION_ID, {
        body: 'We refunded order 8812.',
        visibility: 'PUBLIC',
      });
    });
    expect(await screen.findByText('Reply stored by the server')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(await screen.findByText('Reply sent')).toBeInTheDocument();
  });

  it('keeps the draft and shows an error when the send fails', async () => {
    const user = userEvent.setup();
    sendMessage.mockRejectedValue(new HttpApiError('detail', { status: 500, code: 'INTERNAL' }));

    renderPage();
    await selectFirstConversation();
    await screen.findByText('Thanks for reaching out — checking the invoice now.');

    await user.type(screen.getByRole('textbox'), 'Draft that must survive');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    expect(await screen.findByText('Your message was not sent. Please try again.')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('Draft that must survive');
    expect(screen.queryByText('Reply stored by the server')).toBeNull();
  });

  it('sends internal notes and marks them staff-only', async () => {
    const user = userEvent.setup();
    sendMessage.mockResolvedValue({
      message: makeMessage({
        id: TEST_SECOND_MESSAGE_ID,
        body: 'Finance confirmed the refund',
        visibility: 'INTERNAL',
        createdAt: '2026-09-05T12:00:00.000Z',
      }),
    });

    renderPage();
    await selectFirstConversation();
    await screen.findByText('Thanks for reaching out — checking the invoice now.');

    await user.click(screen.getByRole('button', { name: 'Internal note' }));
    await user.type(screen.getByRole('textbox'), 'Finance confirmed the refund');
    await user.click(screen.getByRole('button', { name: 'Add note' }));

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith('ws-1', TEST_CONVERSATION_ID, {
        body: 'Finance confirmed the refund',
        visibility: 'INTERNAL',
      });
    });
    expect(await screen.findByText('Finance confirmed the refund')).toBeInTheDocument();
    expect(screen.getAllByText('Internal note · staff only').length).toBeGreaterThan(0);
  });

  it('does not offer a composer to a viewer', async () => {
    setWorkspace('viewer');
    renderPage();
    await selectFirstConversation();

    expect(await screen.findByText('Thanks for reaching out — checking the invoice now.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(
      screen.getByText('Your role can read conversations but not send messages.'),
    ).toBeInTheDocument();
  });

  it('withholds the composer for an agent outside the ticket assignment cap', async () => {
    setWorkspace('agent');
    renderPage();
    await selectFirstConversation();

    expect(await screen.findByText('Thanks for reaching out — checking the invoice now.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(
      screen.getByText(/Only the assigned agent, the agent who opened this ticket/),
    ).toBeInTheDocument();
  });

  it('search and filters are sent to the server', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /Invoice shows the wrong total/ });

    await user.type(screen.getByRole('searchbox', { name: 'Search conversations' }), 'csv');

    await waitFor(() => {
      expect(listTickets).toHaveBeenLastCalledWith(
        'ws-1',
        expect.objectContaining({ search: 'csv', page: 1, sort: 'updatedAt' }),
        expect.any(AbortSignal),
      );
    });

    const status = screen.getByLabelText('Filter by ticket status');
    await user.selectOptions(status, 'IN_PROGRESS');
    await waitFor(() => {
      expect(listTickets).toHaveBeenLastCalledWith(
        'ws-1',
        expect.objectContaining({ status: 'IN_PROGRESS', page: 1 }),
        expect.any(AbortSignal),
      );
    });
    // The filtered count is still labelled as tickets, never conversations.
    expect(screen.getByText('2 tickets matching your filters')).toBeInTheDocument();
  });

  it('paginates on the server and clears the selection', async () => {
    const user = userEvent.setup();
    listTickets.mockResolvedValue(makeTicketList([makeTicket()], { total: 45, limit: 20 }));

    renderPage();
    await selectFirstConversation();
    await screen.findByText('Thanks for reaching out — checking the invoice now.');

    await user.click(screen.getByRole('button', { name: 'Page 2' }));

    await waitFor(() => {
      expect(listTickets).toHaveBeenLastCalledWith(
        'ws-1',
        expect.objectContaining({ page: 2 }),
        expect.any(AbortSignal),
      );
    });
    expect(screen.queryByText('Thanks for reaching out — checking the invoice now.')).toBeNull();
  });

  it('drops the selected conversation when the workspace changes', async () => {
    renderPage();
    await selectFirstConversation();
    await screen.findByText('Thanks for reaching out — checking the invoice now.');

    useWorkspaceStore.setState({
      status: 'ready',
      items: [makeWorkspace('ws-2', 'Globex'), makeWorkspace('ws-1', 'Acme')],
      activeWorkspaceId: 'ws-2',
      error: null,
    });
    listTickets.mockResolvedValue(makeTicketList([], { total: 0 }));

    await waitFor(() => {
      expect(screen.queryByText('Thanks for reaching out — checking the invoice now.')).toBeNull();
    });
    expect(listTickets).toHaveBeenLastCalledWith(
      'ws-2',
      expect.anything(),
      expect.any(AbortSignal),
    );
  });

  it('renders the conversation header with ticket and customer links', async () => {
    renderPage();
    await selectFirstConversation();

    const header = await screen.findByRole('region', { name: /Conversation for TKT-000001/ });
    expect(within(header).getByRole('heading', { name: 'Invoice shows the wrong total' })).toBeInTheDocument();
    expect(within(header).getByRole('link', { name: /Open ticket TKT-000001/ })).toHaveAttribute(
      'href',
      `/tickets/${TEST_TICKET_ID}`,
    );
    expect(await within(header).findByRole('link', { name: 'Jordan Lee' })).toHaveAttribute(
      'href',
      '/customers/507f1f77bcf86cd799439011',
    );
  });
});
