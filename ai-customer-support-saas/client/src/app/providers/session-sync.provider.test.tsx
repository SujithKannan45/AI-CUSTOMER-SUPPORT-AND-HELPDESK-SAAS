import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useSessionStore } from '@/features/auth/auth.store';
import { useWorkspaceStore } from '@/features/workspace/workspace.store';
import { makeWorkspace, resetAuthStores, TEST_USER } from '@/test/fixtures';
import { SessionSyncProvider } from './session-sync.provider';

describe('SessionSyncProvider', () => {
  beforeEach(() => {
    resetAuthStores();
  });

  it('clears workspace context when the session becomes anonymous', async () => {
    useWorkspaceStore.setState({
      status: 'ready',
      items: [makeWorkspace('ws-1', 'Acme')],
      activeWorkspaceId: 'ws-1',
    });
    useSessionStore.setState({ status: 'authenticated', user: TEST_USER, error: null });

    render(
      <SessionSyncProvider>
        <p>Application</p>
      </SessionSyncProvider>,
    );
    expect(screen.getByText('Application')).toBeInTheDocument();

    act(() => {
      useSessionStore.getState().reset();
    });

    await waitFor(() => {
      expect(useWorkspaceStore.getState().items).toEqual([]);
    });
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull();
    expect(window.localStorage.getItem('active-workspace-id')).toBeNull();
  });

  it('leaves workspace context alone while the session is authenticated', async () => {
    useWorkspaceStore.setState({
      status: 'ready',
      items: [makeWorkspace('ws-1', 'Acme')],
      activeWorkspaceId: 'ws-1',
    });
    useSessionStore.setState({ status: 'authenticated', user: TEST_USER, error: null });

    render(
      <SessionSyncProvider>
        <p>Application</p>
      </SessionSyncProvider>,
    );

    act(() => {
      useSessionStore.setState({ user: { ...TEST_USER, name: 'Ada Updated' } });
    });

    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-1');
    });
  });
});
