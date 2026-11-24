import { create } from 'zustand';
import { HttpApiError } from '@/services/http-client.service';
import { readStorage, STORAGE_KEYS, writeStorage } from '@/utils/storage.util';
import { workspaceService } from './workspace.service';
import type { WorkspaceListItem } from './types';

export type WorkspaceLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface WorkspaceState {
  status: WorkspaceLoadStatus;
  items: readonly WorkspaceListItem[];
  activeWorkspaceId: string | null;
  error: string | null;
  /** Loads the caller's workspaces; the stored selection wins when still valid. */
  load: () => Promise<void>;
  setActive: (workspaceId: string) => void;
  reset: () => void;
}

/** The stored workspace id is a convenience, never an access grant. */
function storedWorkspaceId(): string | null {
  const stored = readStorage(STORAGE_KEYS.activeWorkspace);
  return stored !== null && stored.length > 0 ? stored : null;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  status: 'idle',
  items: [],
  activeWorkspaceId: null,
  error: null,

  load: async () => {
    if (get().status === 'loading') return;
    set({ status: 'loading', error: null });

    try {
      const payload = await workspaceService.list({ limit: 50 });
      const items = payload.items;
      const previous = get().activeWorkspaceId ?? storedWorkspaceId();
      const stillValid = items.some((item) => item.workspace.id === previous);
      const activeWorkspaceId = stillValid ? previous : (items[0]?.workspace.id ?? null);

      set({ status: 'ready', items, activeWorkspaceId, error: null });
      writeStorage(STORAGE_KEYS.activeWorkspace, activeWorkspaceId);
    } catch (error) {
      set({
        status: 'error',
        error: error instanceof HttpApiError ? error.message : 'Could not load your workspaces.',
      });
    }
  },

  setActive: (workspaceId) => {
    if (!get().items.some((item) => item.workspace.id === workspaceId)) return;
    writeStorage(STORAGE_KEYS.activeWorkspace, workspaceId);
    set({ activeWorkspaceId: workspaceId });
  },

  reset: () => {
    set({ status: 'idle', items: [], activeWorkspaceId: null, error: null });
  },
}));
