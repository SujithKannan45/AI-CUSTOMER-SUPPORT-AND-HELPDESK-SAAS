import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorState } from './states';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional custom fallback; defaults to the shared ErrorState UI. */
  fallback?: (error: Error) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render-time crashes in a subtree so one broken widget cannot take
 * down the whole app. Errors are surfaced via the shared ErrorState UI.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = { error: null };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    // Future: report to a monitoring service (CloudWatch/Sentry) here.
    console.error('Render crash captured by ErrorBoundary:', error, info.componentStack);
  }

  public render(): ReactNode {
    const { error } = this.state;
    if (error !== null) {
      return this.props.fallback?.(error) ?? (
        <ErrorState
          title="Something went wrong"
          message={error.message}
          onRetry={() => window.location.reload()}
        />
    );
    }
    return this.props.children;
  }
}
