import { create } from 'zustand';
import { HttpApiError } from '@/services/http-client.service';
import { readStorage, STORAGE_KEYS, writeStorage } from '@/utils/storage.util';
import { workspaceService } from './workspace.service';
import type { WorkspaceDetailPayload, WorkspaceListItem } from './types';

export type WorkspaceLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface WorkspaceState {
  status: WorkspaceLoadStatus;
  items: readonly WorkspaceListItem[];
  activeWorkspaceId: string | null;
  error: string | null;
  /** Loads the caller's workspaces; the stored selection wins when still valid. */
  load: () => Promise<void>;
  setActive: (workspaceId: string) => void;
  /** Creates a workspace through the API and makes it the active one on success. */
  createWorkspace: (input: { name: string }) => Promise<WorkspaceDetailPayload>;
  reset: () => void;
}

/** The stored workspace id is a convenience, never an access grant. */
function storedWorkspaceId(): string | null {
  const stored = readStorage(STORAGE_KEYS.activeWorkspace);
  return stored !== null && stored.length > 0 ? stored : null;
}

function persistActive(workspaceId: string | null): void {
  writeStorage(STORAGE_KEYS.activeWorkspace, workspaceId);
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
      persistActive(activeWorkspaceId);
    } catch (error) {
      set({
        status: 'error',
        error: error instanceof HttpApiError ? error.message : 'Could not load your workspaces.',
      });
    }
  },

  setActive: (workspaceId) => {
    // Selecting an id that is not in the caller's own list is a no-op: the
    // client can never grant itself a tenant it does not already hold.
    if (!get().items.some((item) => item.workspace.id === workspaceId)) return;

    persistActive(workspaceId);
    set({ activeWorkspaceId: workspaceId });
  },

  createWorkspace: async (input) => {
    const created = await workspaceService.create({ name: input.name });

    set((state) => ({
      status: 'ready',
      items: state.items.some((item) => item.workspace.id === created.workspace.id)
        ? state.items
        : [...state.items, created],
      activeWorkspaceId: created.workspace.id,
      error: null,
    }));
    persistActive(created.workspace.id);

    return created;
  },

  reset: () => {
    // The stored selection is session-scoped: a different account signing in on
    // this browser must not inherit the previous account's tenant preference.
    persistActive(null);
    set({ status: 'idle', items: [], activeWorkspaceId: null, error: null });
  },
}));
