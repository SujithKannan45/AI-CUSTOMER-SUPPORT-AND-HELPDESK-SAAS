import { describe, expect, it, vi } from 'vitest';
import { httpClient } from '@/services/http-client.service';
import { makeTicket, makeTicketList } from '@/test/fixtures';
import { ticketService } from './ticket.service';

const payload = { ticket: makeTicket() };

describe('ticket service', () => {
  it('builds a filtered, paginated list request under the workspace', async () => {
    const get = vi.spyOn(httpClient, 'get').mockResolvedValue(makeTicketList());

    await ticketService.list('ws-1', {
      page: 3,
      limit: 20,
      search: 'invoice',
      status: 'OPEN',
      priority: 'HIGH',
      customerId: 'c1',
    });

    expect(get).toHaveBeenCalledWith(
      '/api/v1/workspaces/ws-1/tickets?page=3&limit=20&search=invoice&status=OPEN&priority=HIGH&customerId=c1',
      {},
    );
  });

  it('encodes ids and forwards the abort signal', async () => {
    const get = vi.spyOn(httpClient, 'get').mockResolvedValue(payload);
    const controller = new AbortController();

    await ticketService.get('ws/1', 't/1', controller.signal);

    expect(get).toHaveBeenCalledWith('/api/v1/workspaces/ws%2F1/tickets/t%2F1', {
      signal: controller.signal,
    });
  });

  it('patches status and priority through their dedicated routes', async () => {
    const patch = vi.spyOn(httpClient, 'patch').mockResolvedValue(payload);

    await ticketService.setStatus('ws-1', 't1', 'IN_PROGRESS');
    await ticketService.setPriority('ws-1', 't1', 'URGENT');

    expect(patch).toHaveBeenNthCalledWith(1, '/api/v1/workspaces/ws-1/tickets/t1/status', {
      status: 'IN_PROGRESS',
    });
    expect(patch).toHaveBeenNthCalledWith(2, '/api/v1/workspaces/ws-1/tickets/t1/priority', {
      priority: 'URGENT',
    });
  });

  it('omits the resolution note when the caller left it empty', async () => {
    const post = vi.spyOn(httpClient, 'post').mockResolvedValue(payload);

    await ticketService.resolve('ws-1', 't1');
    await ticketService.resolve('ws-1', 't1', 'Refunded');

    expect(post).toHaveBeenNthCalledWith(1, '/api/v1/workspaces/ws-1/tickets/t1/resolve', {});
    expect(post).toHaveBeenNthCalledWith(2, '/api/v1/workspaces/ws-1/tickets/t1/resolve', {
      resolutionNote: 'Refunded',
    });
  });

  it('reopens through the guided transition endpoint', async () => {
    const post = vi.spyOn(httpClient, 'post').mockResolvedValue(payload);

    await ticketService.reopen('ws-1', 't1');

    expect(post).toHaveBeenCalledWith('/api/v1/workspaces/ws-1/tickets/t1/reopen');
  });
});
