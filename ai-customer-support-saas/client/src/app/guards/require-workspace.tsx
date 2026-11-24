import { type JSX, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { ErrorState, LoadingState } from '@/components/feedback/states';
import { useWorkspaceBootstrap, useActiveWorkspace } from '@/features/workspace/use-workspace';
import { useWorkspaceStore } from '@/features/workspace/workspace.store';
import { ROUTES } from '@/app/routes/route-paths';

/**
 * Workspace gate for the authenticated application shell.
 *
 * Runs the one-per-session workspace load, then:
 * - loading → a status screen (never a shell with an unresolved tenant);
 * - load failure → retryable error (not a false "no workspaces" state);
 * - no active membership → `/workspaces/select`, where the user can choose or
 *   create a workspace;
 * - otherwise → the shell.
 *
 * The selection is UI context only; authorization still happens per request.
 */
export function RequireWorkspace({ children }: { children: ReactNode }): JSX.Element {
  useWorkspaceBootstrap();

  const status = useWorkspaceStore((state) => state.status);
  const error = useWorkspaceStore((state) => state.error);
  const load = useWorkspaceStore((state) => state.load);
  const { workspace } = useActiveWorkspace();

  if (status === 'idle' || status === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <LoadingState label="Loading your workspaces…" />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex min-h-dvh items-center justify-center px-4">
        <ErrorState
          title="Cannot load your workspaces"
          message={error ?? undefined}
          onRetry={() => {
            void load();
          }}
        />
      </div>
    );
  }

  if (workspace === null) {
    return <Navigate to={ROUTES.workspacesSelect} replace />;
  }

  return <>{children}</>;
}
