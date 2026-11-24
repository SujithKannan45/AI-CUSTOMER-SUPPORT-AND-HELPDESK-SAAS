import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '@/app/providers/toast.provider';
import { SessionSyncProvider } from '@/app/providers/session-sync.provider';
import { authService } from '@/features/auth/auth.service';
import { useSessionStore } from '@/features/auth/auth.store';
import { useWorkspaceStore } from '@/features/workspace/workspace.store';
import { HttpApiError } from '@/services/http-client.service';
import { makeWorkspace, resetAuthStores, TEST_USER } from '@/test/fixtures';
import { UserMenu } from './user-menu';

function renderMenu(): void {
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <ToastProvider>
        <SessionSyncProvider>
          <Routes>
            <Route path="/dashboard" element={<UserMenu />} />
            <Route path="/login" element={<p>Login page</p>} />
          </Routes>
        </SessionSyncProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

async function openAndSignOut(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: /Account menu for Ada Lovelace/ }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
}

describe('UserMenu', () => {
  beforeEach(() => {
    resetAuthStores();
    useSessionStore.setState({ status: 'authenticated', user: TEST_USER, error: null });
    useWorkspaceStore.setState({
      status: 'ready',
      items: [makeWorkspace('ws-1', 'Acme')],
      activeWorkspaceId: 'ws-1',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('signs out through the API, clears tenant state and returns to sign-in', async () => {
    const logout = vi.spyOn(authService, 'logout').mockResolvedValue();

    renderMenu();
    await openAndSignOut();

    expect(await screen.findByText('Login page')).toBeInTheDocument();
    expect(logout).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().status).toBe('anonymous');
    expect(useWorkspaceStore.getState().items).toEqual([]);
  });

  it('still leaves the signed-in UI and warns when the API cannot be reached', async () => {
    vi.spyOn(authService, 'logout').mockRejectedValue(
      new HttpApiError('Network unreachable.', { status: 0, code: 'NETWORK_ERROR' }),
    );

    renderMenu();
    await openAndSignOut();

    expect(await screen.findByText('Signed out on this device')).toBeInTheDocument();
    expect(await screen.findByText('Login page')).toBeInTheDocument();
    expect(useSessionStore.getState().status).toBe('anonymous');
  });
});
