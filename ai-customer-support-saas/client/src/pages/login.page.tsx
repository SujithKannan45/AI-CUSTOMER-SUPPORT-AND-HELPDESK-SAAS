import { useEffect, useRef, type JSX } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { LoadingState } from '@/components/feedback/states';
import { ThemeToggle } from '@/layouts/components/theme-toggle';
import { AuthShell } from '@/features/auth/components/auth-shell';
import { SignInForm } from '@/features/auth/components/sign-in-form';
import { useSessionStore } from '@/features/auth/auth.store';
import { postLoginDestination, readNotice } from '@/features/auth/redirect';

/**
 * Public sign-in route.
 *
 * - Restores the session first: a signed-in visitor is sent straight to the
 *   route they were trying to reach (never shown the form again).
 * - A session that cannot be resolved because the API is down still shows the
 *   form; submitting it surfaces a concrete network error.
 * - While restoring, the panel shows a status message instead of a form that
 *   could race the session.
 */
export function LoginPage(): JSX.Element {
  const status = useSessionStore((state) => state.status);
  const bootstrap = useSessionStore((state) => state.bootstrap);
  const location = useLocation();
  const notice = readNotice(location.state);
  const hasSubmitted = useRef(false);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // A session restored on arrival redirects here. A login just submitted is
  // handled by the form itself (it knows whether a workspace exists).
  if (status === 'authenticated' && !hasSubmitted.current) {
    return <Navigate to={postLoginDestination(location.state)} replace />;
  }

  const isResolving = status === 'idle' || status === 'loading';

  return (
    <AuthShell
      title="Sign in"
      description="Use your work account to reach your support workspace."
      actions={<ThemeToggle />}
    >
      {isResolving ? (
        <LoadingState label="Checking your session…" />
      ) : (
        <SignInForm
          notice={notice}
          onAuthStart={() => {
            hasSubmitted.current = true;
          }}
        />
      )}
    </AuthShell>
  );
}
