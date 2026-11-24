import type { AuthSessionPayload, PublicUser } from '@/features/auth/types';
import { useSessionStore } from '@/features/auth/auth.store';
import type { WorkspaceListItem, WorkspaceRole } from '@/features/workspace/types';
import { useWorkspaceStore } from '@/features/workspace/workspace.store';
import { clearAccessToken } from '@/services/auth-token.store';

export const TEST_USER: PublicUser = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  status: 'active',
  emailVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

export function makeWorkspace(id: string, name: string, role: WorkspaceRole = 'owner'): WorkspaceListItem {
  return {
    workspace: {
      id,
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      ownerId: 'user-1',
      status: 'active',
      settings: { timezone: 'UTC', locale: 'en' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    membership: {
      id: `member-${id}`,
      workspaceId: id,
      userId: 'user-1',
      role,
      status: 'active',
      joinedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

export function makeSessionPayload(): AuthSessionPayload {
  return {
    user: TEST_USER,
    tokens: { accessToken: 'memory-only-token', expiresIn: 900, refreshInCookie: true },
  };
}

/** Returns every store the auth/workspace tests share to a clean slate. */
export function resetAuthStores(): void {
  useSessionStore.setState({ status: 'idle', user: null, error: null });
  useWorkspaceStore.setState({ status: 'idle', items: [], activeWorkspaceId: null, error: null });
  clearAccessToken();
  window.localStorage.clear();
}
