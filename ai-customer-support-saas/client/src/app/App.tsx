import type { JSX } from 'react';
import { AppRouter } from './router';
import { AppProviders } from './providers/app-providers';
import { ErrorBoundary } from '@/components/feedback/error-boundary';

/** Root component: global error containment + cross-cutting providers + routing. */
export function App(): JSX.Element {
  return (
    <ErrorBoundary>
      <AppProviders>
        <AppRouter />
      </AppProviders>
    </ErrorBoundary>
  );
}
