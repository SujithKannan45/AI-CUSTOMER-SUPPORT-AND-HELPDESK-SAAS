import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '@/hooks/use-toast';
import { useSessionStore } from './auth.store';
import { ROUTES } from '@/app/routes/route-paths';

export interface SignOutAction {
  readonly signOut: () => Promise<void>;
  readonly isSigningOut: boolean;
}

/**
 * Sign-out interaction shared by the user menu and the workspace picker.
 *
 * Local session/workspace state is always cleared — a stale authenticated UI
 * must never survive — but the UI only claims server-side revocation when the
 * logout request actually succeeded.
 */
export function useSignOut(): SignOutAction {
  const signOutFromStore = useSessionStore((state) => state.signOut);
  const navigate = useNavigate();
  const { toast } = useToast();
  const [isSigningOut, setIsSigningOut] = useState(false);

  const signOut = useCallback(async (): Promise<void> => {
    if (isSigningOut) return;
    setIsSigningOut(true);

    try {
      const { remoteRevoked } = await signOutFromStore();
      if (!remoteRevoked) {
        toast({
          title: 'Signed out on this device',
          description:
            'We could not reach the server, so this browser’s session may still be active elsewhere. Check your connection if that matters.',
          tone: 'warning',
          durationMs: 8_000,
        });
      }
      void navigate(ROUTES.login, { replace: true });
    } finally {
      setIsSigningOut(false);
    }
  }, [isSigningOut, navigate, signOutFromStore, toast]);

  return { signOut, isSigningOut };
}
