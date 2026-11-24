import { useEffect, type JSX, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ErrorState, LoadingState } from '@/components/feedback/states';
import { useSessionStore } from '@/features/auth/auth.store';
import { subscribeToAuthFailure } from '@/services/auth-token.store';
import { ROUTES } from '@/app/routes/route-paths';

/**
 * Route guard for every authenticated subtree.
 *
 * - Resolves the session once per app load (silent refresh-cookie bootstrap).
 * - While resolving: a loading state, never a flash of protected content.
 * - Logged out: redirect to /login, remembering where the user was going.
 * - API unreachable: an explicit error state with retry (not a false logout).
 * - An expired session ends the session locally and sends the user to /login.
 *
 * There is no client-side shortcut: the SPA never trusts a workspace id or a
 * role, and never fabricates a local session to "pass" this guard.
 */
export function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const status = useSessionStore((state) => state.status);
  const error = useSessionStore((state) => state.error);
  const bootstrap = useSessionStore((state) => state.bootstrap);
  const reset = useSessionStore((state) => state.reset);
  const location = useLocation();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => subscribeToAuthFailure(reset), [reset]);

  if (status === 'idle' || status === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <LoadingState label="Restoring your session…" />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex min-h-dvh items-center justify-center px-4">
        <ErrorState
          title="Cannot reach the API"
          message={error ?? undefined}
          onRetry={() => {
            void bootstrap();
          }}
        />
      </div>
    );
  }

  if (status === 'anonymous') {
    return <Navigate to={ROUTES.login} replace state={{ from: `${location.pathname}${location.search}` }} />;
  }

  return <>{children}</>;
}
