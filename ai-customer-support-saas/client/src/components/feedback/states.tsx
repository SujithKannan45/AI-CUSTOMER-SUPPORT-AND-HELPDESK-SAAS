import type { JSX, ReactNode } from 'react';
import { AlertTriangle, Inbox, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function LoadingState({ label = 'Loading…' }: { label?: string }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-ink-500">
      <Loader2 aria-hidden className="h-7 w-7 animate-spin text-brand-600" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

export function ErrorState({ title = 'Something went wrong', message, onRetry }: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="rounded-full bg-red-50 p-3">
        <AlertTriangle aria-hidden className="h-6 w-6 text-danger" />
      </div>
      <div>
        <h3 className="text-base font-semibold text-ink-900">{title}</h3>
        {message ? <p className="mt-0.5 max-w-sm text-sm text-ink-500">{message}</p> : null}
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw aria-hidden className="h-3.5 w-3.5" />
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, message, icon, action }: {
  title: string;
  message?: string;
  icon?: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="rounded-full bg-ink-100 p-3 text-ink-500">{icon ?? <Inbox className="h-6 w-6" />}</div>
      <div>
        <h3 className="text-base font-semibold text-ink-900">{title}</h3>
        {message ? <p className="mt-0.5 max-w-sm text-sm text-ink-500">{message}</p> : null}
      </div>
      {action}
    </div>
  );
}
