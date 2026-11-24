import type { JSX, ReactNode } from 'react';
import { ThemeProvider } from './theme.provider';
import { ToastProvider } from './toast.provider';

/**
 * Single place where cross-cutting providers compose. Order matters: theme is
 * applied before any surface renders; toasts need the theme's tokens only.
 * Router providers are supplied by `AppRouter` (data router), so they are not
 * duplicated here.
 */
export function AppProviders({ children }: { children: ReactNode }): JSX.Element {
  return (
    <ThemeProvider>
      <ToastProvider>{children}</ToastProvider>
    </ThemeProvider>
  );
}
