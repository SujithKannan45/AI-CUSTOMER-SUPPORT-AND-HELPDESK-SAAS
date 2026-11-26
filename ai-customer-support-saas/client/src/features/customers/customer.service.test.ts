import { describe, expect, it, vi } from 'vitest';
import { httpClient } from '@/services/http-client.service';
import { makeCustomer, makeCustomerList } from '@/test/fixtures';
import { customerService } from './customer.service';

describe('customer service', () => {
  it('builds a filtered, paginated list request under the workspace', async () => {
    const get = vi.spyOn(httpClient, 'get').mockResolvedValue(makeCustomerList());

    await customerService.list('ws-1', {
      page: 2,
      limit: 20,
      search: 'jordan',
      status: 'active',
      archiveState: 'all',
    });

    expect(get).toHaveBeenCalledWith(
      '/api/v1/workspaces/ws-1/customers?page=2&limit=20&search=jordan&status=active&archiveState=all',
      {},
    );
  });

  it('omits an empty search term so the server never sees search=', async () => {
    const get = vi.spyOn(httpClient, 'get').mockResolvedValue(makeCustomerList());

    await customerService.list('ws-1', { page: 1, limit: 20, search: '' });

    expect(get).toHaveBeenCalledWith('/api/v1/workspaces/ws-1/customers?page=1&limit=20', {});
  });

  it('encodes ids instead of interpolating them raw', async () => {
    const get = vi.spyOn(httpClient, 'get').mockResolvedValue({ customer: makeCustomer() });

    await customerService.get('ws/../other', 'id/../x');

    expect(get).toHaveBeenCalledWith(
      '/api/v1/workspaces/ws%2F..%2Fother/customers/id%2F..%2Fx',
      {},
    );
  });

  it('clears an optional field with an explicit null', async () => {
    const patch = vi.spyOn(httpClient, 'patch').mockResolvedValue({
      customer: makeCustomer({ email: null }),
    });

    await customerService.update('ws-1', 'c1', { email: null });

    expect(patch).toHaveBeenCalledWith('/api/v1/workspaces/ws-1/customers/c1', { email: null });
  });

  it('uses the dedicated archive and restore sub-routes', async () => {
    const patch = vi
      .spyOn(httpClient, 'patch')
      .mockResolvedValue({ customer: makeCustomer({ archivedAt: '2026-09-12T00:00:00.000Z' }) });

    await customerService.archive('ws-1', 'c1');
    await customerService.restore('ws-1', 'c1');

    expect(patch).toHaveBeenNthCalledWith(1, '/api/v1/workspaces/ws-1/customers/c1/archive');
    expect(patch).toHaveBeenNthCalledWith(2, '/api/v1/workspaces/ws-1/customers/c1/restore');
  });

  it('forwards the abort signal so an unmounted page cancels its read', async () => {
    const get = vi.spyOn(httpClient, 'get').mockResolvedValue(makeCustomerList());
    const controller = new AbortController();

    await customerService.list('ws-1', { page: 1 }, controller.signal);

    expect(get).toHaveBeenCalledWith('/api/v1/workspaces/ws-1/customers?page=1', {
      signal: controller.signal,
    });
  });
});
