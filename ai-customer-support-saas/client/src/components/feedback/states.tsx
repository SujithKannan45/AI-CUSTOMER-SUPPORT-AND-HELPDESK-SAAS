import type { JSX, ReactNode } from 'react';
import { AlertTriangle, Inbox, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function LoadingState({ label = 'Loading…' }: { label?: string }): JSX.Element {
  return (
    <div role="status" aria-live="polite" className="flex flex-col items-center justify-center gap-3 py-16 text-muted">
      <Loader2 aria-hidden className="h-7 w-7 animate-spin text-primary" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}): JSX.Element {
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="rounded-full bg-danger-soft p-3">
        <AlertTriangle aria-hidden className="h-6 w-6 text-danger" />
      </div>
      <div>
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        {message !== undefined ? <p className="mt-1 max-w-sm text-sm leading-6 text-muted">{message}</p> : null}
      </div>
      {onRetry !== undefined ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw aria-hidden className="h-3.5 w-3.5" />
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  message,
  icon,
  action,
}: {
  title: string;
  message?: string;
  icon?: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="rounded-full bg-surface-hover p-3 text-muted">{icon ?? <Inbox aria-hidden className="h-6 w-6" />}</div>
      <div>
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        {message !== undefined ? <p className="mt-1 max-w-sm text-sm leading-6 text-muted">{message}</p> : null}
      </div>
      {action}
    </div>
  );
}
