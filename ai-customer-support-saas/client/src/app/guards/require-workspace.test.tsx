import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useSessionStore } from '@/features/auth/auth.store';
import { workspaceService } from '@/features/workspace/workspace.service';
import { HttpApiError } from '@/services/http-client.service';
import { makeWorkspace, resetAuthStores, TEST_USER } from '@/test/fixtures';
import { RequireWorkspace } from './require-workspace';

function renderGate(): void {
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Routes>
        <Route
          path="/dashboard"
          element={
            <RequireWorkspace>
              <p>Protected shell</p>
            </RequireWorkspace>
          }
        />
        <Route path="/workspaces/select" element={<p>Workspace picker</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function listPayload(items: ReturnType<typeof makeWorkspace>[]) {
  return { items, page: 1, limit: 50, total: items.length, hasMore: false };
}

describe('RequireWorkspace', () => {
  beforeEach(() => {
    resetAuthStores();
    useSessionStore.setState({ status: 'authenticated', user: TEST_USER, error: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the shell for an account with an active workspace', async () => {
    vi.spyOn(workspaceService, 'list').mockResolvedValue(listPayload([makeWorkspace('ws-1', 'Acme')]));

    renderGate();

    expect(await screen.findByText('Protected shell')).toBeInTheDocument();
  });

  it('sends an account without a workspace to the picker', async () => {
    vi.spyOn(workspaceService, 'list').mockResolvedValue(listPayload([]));

    renderGate();

    expect(await screen.findByText('Workspace picker')).toBeInTheDocument();
    expect(screen.queryByText('Protected shell')).not.toBeInTheDocument();
  });

  it('keeps a load failure retryable instead of treating it as no workspace', async () => {
    vi.spyOn(workspaceService, 'list').mockRejectedValue(
      new HttpApiError('Network unreachable.', { status: 0, code: 'NETWORK_ERROR' }),
    );

    renderGate();

    expect(await screen.findByText('Cannot load your workspaces')).toBeInTheDocument();
    expect(screen.queryByText('Workspace picker')).not.toBeInTheDocument();
  });
});
