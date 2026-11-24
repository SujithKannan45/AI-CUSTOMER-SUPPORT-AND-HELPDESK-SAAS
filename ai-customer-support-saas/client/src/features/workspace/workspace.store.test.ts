import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceService } from './workspace.service';
import { useWorkspaceStore } from './workspace.store';
import { readStorage, STORAGE_KEYS, writeStorage } from '@/utils/storage.util';
import { makeWorkspace, resetAuthStores } from '@/test/fixtures';

function listPayload(items: ReturnType<typeof makeWorkspace>[]) {
  return { items, page: 1, limit: 50, total: items.length, hasMore: false };
}

describe('workspace store', () => {
  beforeEach(() => {
    resetAuthStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads memberships and restores a still-valid stored selection', async () => {
    writeStorage(STORAGE_KEYS.activeWorkspace, 'ws-2');
    vi.spyOn(workspaceService, 'list').mockResolvedValue(
      listPayload([makeWorkspace('ws-1', 'Acme'), makeWorkspace('ws-2', 'Globex')]),
    );

    await useWorkspaceStore.getState().load();

    expect(useWorkspaceStore.getState().status).toBe('ready');
    expect(useWorkspaceStore.getState().items).toHaveLength(2);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-2');
  });

  it('falls back to the first membership when the stored selection is gone', async () => {
    writeStorage(STORAGE_KEYS.activeWorkspace, 'ws-deleted');
    vi.spyOn(workspaceService, 'list').mockResolvedValue(listPayload([makeWorkspace('ws-1', 'Acme')]));

    await useWorkspaceStore.getState().load();

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-1');
    expect(readStorage(STORAGE_KEYS.activeWorkspace)).toBe('ws-1');
  });

  it('surfaces a retryable error when the list cannot be loaded', async () => {
    vi.spyOn(workspaceService, 'list').mockRejectedValue(new Error('offline'));

    await useWorkspaceStore.getState().load();

    expect(useWorkspaceStore.getState().status).toBe('error');
    expect(useWorkspaceStore.getState().error).toBe('Could not load your workspaces.');
  });

  it('cannot activate a workspace the caller does not hold', async () => {
    vi.spyOn(workspaceService, 'list').mockResolvedValue(listPayload([makeWorkspace('ws-1', 'Acme')]));
    await useWorkspaceStore.getState().load();

    useWorkspaceStore.getState().setActive('ws-foreign');

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-1');
    expect(readStorage(STORAGE_KEYS.activeWorkspace)).toBe('ws-1');
  });

  it('adds a server-created workspace and makes it active', async () => {
    const created = makeWorkspace('ws-new', 'New Team');
    const create = vi.spyOn(workspaceService, 'create').mockResolvedValue(created);

    const result = await useWorkspaceStore.getState().createWorkspace({ name: 'New Team' });

    expect(create).toHaveBeenCalledWith({ name: 'New Team' });
    expect(result).toEqual(created);
    expect(useWorkspaceStore.getState().items).toEqual([created]);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-new');
    expect(readStorage(STORAGE_KEYS.activeWorkspace)).toBe('ws-new');
  });

  it('clears tenant selection on reset', async () => {
    vi.spyOn(workspaceService, 'list').mockResolvedValue(listPayload([makeWorkspace('ws-1', 'Acme')]));
    await useWorkspaceStore.getState().load();

    useWorkspaceStore.getState().reset();

    expect(useWorkspaceStore.getState().items).toEqual([]);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull();
    expect(useWorkspaceStore.getState().status).toBe('idle');
    expect(readStorage(STORAGE_KEYS.activeWorkspace)).toBeNull();
  });
});
