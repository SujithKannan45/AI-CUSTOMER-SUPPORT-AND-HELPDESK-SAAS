import type { JSX, ReactNode } from 'react';
import { ThemeProvider } from './theme.provider';
import { ToastProvider } from './toast.provider';
import { SessionSyncProvider } from './session-sync.provider';

/**
 * Single place where cross-cutting providers compose. Order matters: theme is
 * applied before any surface renders; toasts need the theme's tokens only;
 * session sync needs both stores and must sit above the router so it survives
 * every route change. Router providers are supplied by `AppRouter` (data
 * router), so they are not duplicated here.
 */
export function AppProviders({ children }: { children: ReactNode }): JSX.Element {
  return (
    <ThemeProvider>
      <ToastProvider>
        <SessionSyncProvider>{children}</SessionSyncProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
