import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '@/app/providers/toast.provider';
import { useSessionStore } from '@/features/auth/auth.store';
import { workspaceService } from '@/features/workspace/workspace.service';
import { useWorkspaceStore } from '@/features/workspace/workspace.store';
import { HttpApiError } from '@/services/http-client.service';
import { makeWorkspace, resetAuthStores } from '@/test/fixtures';
import { WorkspacesSelectPage } from './workspaces-select.page';

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/workspaces/select']}>
      <ToastProvider>
        <Routes>
          <Route path="/workspaces/select" element={<WorkspacesSelectPage />} />
          <Route path="/dashboard" element={<p>Dashboard page</p>} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

function listPayload(items: ReturnType<typeof makeWorkspace>[]) {
  return { items, page: 1, limit: 50, total: items.length, hasMore: false };
}

describe('WorkspacesSelectPage', () => {
  beforeEach(() => {
    resetAuthStores();
    useSessionStore.setState({
      status: 'authenticated',
      user: { ...{ id: 'user-1', name: 'Ada Lovelace', email: 'ada@example.com' }, status: 'active', emailVerified: true, createdAt: '2026-01-01T00:00:00.000Z' },
      error: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('announces loading while memberships are fetched', async () => {
    vi.spyOn(workspaceService, 'list').mockReturnValue(new Promise(() => undefined));
    renderPage();

    expect(await screen.findByText('Loading your workspaces…')).toBeInTheDocument();
  });

  it('shows an empty state with real creation as the next step', async () => {
    vi.spyOn(workspaceService, 'list').mockResolvedValue(listPayload([]));
    renderPage();

    expect(await screen.findByText('No workspace yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create workspace' })).toBeInTheDocument();
  });

  it('shows a retryable error when the API fails', async () => {
    vi.spyOn(workspaceService, 'list').mockRejectedValue(
      new HttpApiError('Network unreachable.', { status: 0, code: 'NETWORK_ERROR' }),
    );
    renderPage();

    expect(await screen.findByText('Cannot load your workspaces')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument();
  });

  it('lists memberships with roles and activates the chosen workspace', async () => {
    vi.spyOn(workspaceService, 'list').mockResolvedValue(
      listPayload([makeWorkspace('ws-1', 'Acme Support'), makeWorkspace('ws-2', 'Globex Helpdesk', 'viewer')]),
    );
    renderPage();

    expect(await screen.findByText('Acme Support')).toBeInTheDocument();
    expect(screen.getByText('Viewer')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Globex Helpdesk/ }));

    expect(await screen.findByText('Dashboard page')).toBeInTheDocument();
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-2');
  });
});
