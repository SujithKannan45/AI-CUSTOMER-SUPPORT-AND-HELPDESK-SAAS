import { useEffect } from 'react';
import { useSessionStore } from '@/features/auth/auth.store';
import { useWorkspaceStore, type WorkspaceLoadStatus } from './workspace.store';
import type { WorkspaceDto, WorkspaceListItem, WorkspaceRole } from './types';

/**
 * Workspace context hooks — the app shell's view of "which tenant am I in".
 *
 * There is deliberately no client-side authorization here: the server resolves
 * the caller's membership on every request. These hooks only choose which
 * workspace the UI is *looking at*.
 */

/** Loads the workspace list when the session becomes authenticated. */
export function useWorkspaceBootstrap(): void {
  const sessionStatus = useSessionStore((state) => state.status);
  const load = useWorkspaceStore((state) => state.load);
  const reset = useWorkspaceStore((state) => state.reset);

  useEffect(() => {
    if (sessionStatus === 'authenticated') {
      void load();
    } else if (sessionStatus === 'anonymous') {
      reset();
    }
  }, [sessionStatus, load, reset]);
}

export interface ActiveWorkspaceContext {
  readonly items: readonly WorkspaceListItem[];
  readonly workspace: WorkspaceDto | null;
  readonly role: WorkspaceRole | null;
  readonly status: WorkspaceLoadStatus;
  readonly error: string | null;
  readonly setActive: (workspaceId: string) => void;
}

/** The active workspace (null while loading or when the user has none). */
export function useActiveWorkspace(): ActiveWorkspaceContext {
  const items = useWorkspaceStore((state) => state.items);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const status = useWorkspaceStore((state) => state.status);
  const error = useWorkspaceStore((state) => state.error);
  const setActive = useWorkspaceStore((state) => state.setActive);

  const active = items.find((item) => item.workspace.id === activeWorkspaceId);

  return {
    items,
    workspace: active?.workspace ?? null,
    role: active?.membership.role ?? null,
    status,
    error,
    setActive,
  };
}
