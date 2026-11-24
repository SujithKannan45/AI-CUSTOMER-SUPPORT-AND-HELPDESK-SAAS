import { useEffect, type JSX, type ReactNode } from 'react';
import { useSessionStore } from '@/features/auth/auth.store';
import { useWorkspaceStore } from '@/features/workspace/workspace.store';

/**
 * App-level bridge between session and tenant state.
 *
 * The auth and workspace features deliberately do not import each other's
 * stores. Whenever the session leaves `authenticated` for `anonymous` (sign-out,
 * expired session, auth failure), this provider clears the workspace list and
 * persisted selection so no tenant context survives the session.
 */
export function SessionSyncProvider({ children }: { children: ReactNode }): JSX.Element {
  useEffect(() => {
    return useSessionStore.subscribe((state, previous) => {
      if (state.status === 'anonymous' && previous.status !== 'anonymous') {
        useWorkspaceStore.getState().reset();
      }
    });
  }, []);

  return <>{children}</>;
}
