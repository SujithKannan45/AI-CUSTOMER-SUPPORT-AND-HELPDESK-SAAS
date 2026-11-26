import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ToastProvider } from '@/app/providers/toast.provider';
import { useSessionStore } from '@/features/auth/auth.store';
import { customerService } from '@/features/customers/customer.service';
import { useWorkspaceStore } from '@/features/workspace/workspace.store';
import { HttpApiError } from '@/services/http-client.service';
import {
  makeCustomer,
  makeCustomerList,
  makeWorkspace,
  resetAuthStores,
  TEST_CUSTOMER_ID,
  TEST_USER,
} from '@/test/fixtures';
import { CustomersPage } from './customers.page';

let list: MockInstance<typeof customerService.list>;
let create: MockInstance<typeof customerService.create>;
let restore: MockInstance<typeof customerService.restore>;

function renderPage(): void {
  render(
    <ToastProvider>
      <MemoryRouter>
        <CustomersPage />
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe('CustomersPage', () => {
  beforeEach(() => {
    resetAuthStores();
    useSessionStore.setState({ status: 'authenticated', user: TEST_USER, error: null });
    useWorkspaceStore.setState({
      status: 'ready',
      items: [makeWorkspace('ws-1', 'Acme')],
      activeWorkspaceId: 'ws-1',
      error: null,
    });
    list = vi.spyOn(customerService, 'list').mockResolvedValue(makeCustomerList());
    create = vi
      .spyOn(customerService, 'create')
      .mockResolvedValue({ customer: makeCustomer({ name: 'New Person' }) });
    restore = vi.spyOn(customerService, 'restore').mockResolvedValue({ customer: makeCustomer() });
  });

  it('renders records returned by the API', async () => {
    renderPage();

    expect(await screen.findByRole('link', { name: /Jordan Lee/ })).toHaveAttribute(
      'href',
      `/customers/${TEST_CUSTOMER_ID}`,
    );
    expect(screen.getByText('jordan@example.com')).toBeInTheDocument();
    expect(screen.getByText('1 customer')).toBeInTheDocument();

    const table = screen.getByRole('table');
    expect(within(table).getByText('Active')).toBeInTheDocument();
    expect(within(table).getByText('vip')).toBeInTheDocument();
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

  it('shows a loading state before the first page arrives', () => {
    list.mockReturnValue(new Promise(() => undefined));

    renderPage();

    expect(screen.getByText('Loading customers…')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows an empty state with a real create action for owners', async () => {
    const user = userEvent.setup();
    list.mockResolvedValue(makeCustomerList([], { total: 0 }));

    renderPage();

    expect(await screen.findByText('No customers yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add your first customer' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('renders a retryable error and reloads on retry', async () => {
    const user = userEvent.setup();
    list
      .mockRejectedValueOnce(new HttpApiError('boom', { status: 500, code: 'INTERNAL' }))
      .mockResolvedValue(makeCustomerList());

    renderPage();

    expect(await screen.findByText('Customers unavailable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByRole('link', { name: /Jordan Lee/ })).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('renders a non-retryable authorization state for a 403', async () => {
    list.mockRejectedValue(new HttpApiError('forbidden detail', { status: 403, code: 'FORBIDDEN' }));

    renderPage();

    expect(await screen.findByText('Customer access required')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
    expect(screen.queryByText(/forbidden detail/)).toBeNull();
  });

  it('hides creation from roles without customer.create', async () => {
    useWorkspaceStore.setState({
      status: 'ready',
      items: [makeWorkspace('ws-1', 'Acme', 'viewer')],
      activeWorkspaceId: 'ws-1',
      error: null,
    });

    renderPage();
    await screen.findByRole('link', { name: /Jordan Lee/ });

    expect(screen.queryByRole('button', { name: 'New customer' })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).toBeNull();
  });

  it('sends the debounced search term to the API and resets to page one', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('link', { name: /Jordan Lee/ });

    await user.type(screen.getByRole('searchbox'), 'jordan');

    await waitFor(() => {
      expect(list).toHaveBeenLastCalledWith(
        'ws-1',
        expect.objectContaining({ search: 'jordan', page: 1 }),
        expect.any(AbortSignal),
      );
    });
  });

  it('sends the server-side status filter', async () => {
    renderPage();
    await screen.findByRole('link', { name: /Jordan Lee/ });

    fireEvent.change(screen.getByLabelText('Filter by customer status'), {
      target: { value: 'blocked' },
    });

    await waitFor(() => {
      expect(list).toHaveBeenLastCalledWith(
        'ws-1',
        expect.objectContaining({ status: 'blocked', page: 1 }),
        expect.any(AbortSignal),
      );
    });
  });

  it('paginates on the server', async () => {
    const user = userEvent.setup();
    list.mockResolvedValue(makeCustomerList([makeCustomer()], { total: 45, limit: 20 }));

    renderPage();
    await screen.findByRole('link', { name: /Jordan Lee/ });

    await user.click(screen.getByRole('button', { name: 'Page 2' }));

    await waitFor(() => {
      expect(list).toHaveBeenLastCalledWith(
        'ws-1',
        expect.objectContaining({ page: 2 }),
        expect.any(AbortSignal),
      );
    });
  });

  it('restores an archived customer through the dedicated endpoint', async () => {
    const user = userEvent.setup();
    list.mockResolvedValue(
      makeCustomerList([makeCustomer({ archivedAt: '2026-09-12T00:00:00.000Z' })]),
    );

    renderPage();
    await screen.findByRole('link', { name: /Jordan Lee/ });

    fireEvent.change(screen.getByLabelText('Filter by archive state'), {
      target: { value: 'archived' },
    });

    await user.click(await screen.findByRole('button', { name: 'Restore' }));

    await waitFor(() => {
      expect(restore).toHaveBeenCalledWith('ws-1', TEST_CUSTOMER_ID);
    });
    await waitFor(() => {
      expect(list).toHaveBeenCalledTimes(3);
    });
  });

  it('creates a customer through the API and refreshes the list', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('link', { name: /Jordan Lee/ });

    await user.click(screen.getByRole('button', { name: 'New customer' }));
    await user.type(screen.getByLabelText(/^Name/), 'New Person');
    await user.click(screen.getByRole('button', { name: 'Create customer' }));

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith('ws-1', { name: 'New Person', status: 'active' });
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(list).toHaveBeenCalledTimes(2);
  });
});
