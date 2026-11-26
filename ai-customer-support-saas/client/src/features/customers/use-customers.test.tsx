import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { HttpApiError } from '@/services/http-client.service';
import { makeCustomer, makeCustomerList, TEST_SECOND_CUSTOMER_ID } from '@/test/fixtures';
import { customerService } from './customer.service';
import { useCustomers } from './use-customers';
import type { CustomerListPayload } from './types';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

const firstPage = makeCustomerList();
const secondPage = makeCustomerList([
  makeCustomer({ id: TEST_SECOND_CUSTOMER_ID, name: 'Nia Patel' }),
]);

const FILTERS = { search: '', status: '', archiveState: 'live', page: 1, limit: 20 } as const;

describe('useCustomers', () => {
  let list: MockInstance<typeof customerService.list>;

  beforeEach(() => {
    list = vi.spyOn(customerService, 'list').mockResolvedValue(firstPage);
  });

  it('loads the first page for the active workspace with the server query', async () => {
    const { result } = renderHook(() => useCustomers({ workspaceId: 'ws-1', filters: FILTERS }));

    expect(result.current.status).toBe('loading');
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    expect(result.current.data?.items[0]?.name).toBe('Jordan Lee');
    expect(list).toHaveBeenCalledWith(
      'ws-1',
      {
        page: 1,
        limit: 20,
        archiveState: 'live',
        sort: 'createdAt',
        order: 'desc',
      },
      expect.any(AbortSignal),
    );
  });

  it('never calls the API without a workspace', () => {
    const { result } = renderHook(() => useCustomers({ workspaceId: null, filters: FILTERS }));

    expect(result.current.status).toBe('idle');
    expect(result.current.data).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it('clears the previous workspace immediately and ignores its late response', async () => {
    const oldPage = deferred<CustomerListPayload>();

    list.mockImplementation((workspaceId) =>
      workspaceId === 'ws-1' ? oldPage.promise : Promise.resolve(secondPage),
    );

    const { result, rerender } = renderHook(
      ({ workspaceId }: { workspaceId: string }) =>
        useCustomers({ workspaceId, filters: FILTERS }),
      { initialProps: { workspaceId: 'ws-1' } },
    );

    await waitFor(() => {
      expect(list).toHaveBeenCalledWith('ws-1', expect.anything(), expect.any(AbortSignal));
    });

    rerender({ workspaceId: 'ws-2' });

    expect(result.current.status).toBe('loading');
    expect(result.current.data).toBeNull();

    await waitFor(() => {
      expect(result.current.data?.items[0]?.name).toBe('Nia Patel');
    });

    await act(async () => {
      oldPage.resolve(firstPage);
      await Promise.resolve();
    });

    expect(result.current.data?.items[0]?.name).toBe('Nia Patel');
    expect(result.current.workspaceId).toBe('ws-2');
  });

  it('maps a 403 to a forbidden state without exposing the server body', async () => {
    list.mockRejectedValue(new HttpApiError('internal detail', { status: 403, code: 'FORBIDDEN' }));

    const { result } = renderHook(() => useCustomers({ workspaceId: 'ws-1', filters: FILTERS }));

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.forbidden).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.error).not.toContain('internal detail');
  });

  it('refetches on refresh without dropping the current page', async () => {
    const { result } = renderHook(() => useCustomers({ workspaceId: 'ws-1', filters: FILTERS }));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => {
      expect(list).toHaveBeenCalledTimes(2);
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.data).not.toBeNull();
  });
});
