import type { JSX } from 'react';
import { AppRouter } from './router';
import { ErrorBoundary } from '@/components/feedback/error-boundary';

/** Root component: global error containment + routing. Providers land per phase. */
export function App(): JSX.Element {
  return (
    <ErrorBoundary>
      <AppRouter />
    </ErrorBoundary>
  );
}
