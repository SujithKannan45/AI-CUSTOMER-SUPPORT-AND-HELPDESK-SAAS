import type { JSX } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { EmptyState } from '@/components/feedback/states';
import { Skeleton } from '@/components/ui/skeleton';

/** Full-dashboard skeleton; the region announces its own loading state. */
export function DashboardLoadingState(): JSX.Element {
  return (
    <div role="status" aria-live="polite" className="space-y-4">
      <span className="sr-only">Loading analytics…</span>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="space-y-2 rounded-xl border border-border bg-surface p-5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-border bg-surface p-5">
        <Skeleton className="mb-4 h-4 w-36" />
        <Skeleton className="h-64 w-full" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-surface p-5">
          <Skeleton className="mb-4 h-4 w-28" />
          <Skeleton className="h-48 w-full" />
        </div>
        <div className="rounded-xl border border-border bg-surface p-5">
          <Skeleton className="mb-4 h-4 w-40" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    </div>
  );
}

/** 403: real authorization outcome — no retry that can only fail again. */
export function DashboardForbiddenState(): JSX.Element {
  return (
    <div className="rounded-xl border border-border bg-surface">
      <EmptyState
        icon={<AlertTriangle aria-hidden className="h-6 w-6 text-warning" />}
        title="Analytics access required"
        message="Analytics is limited to workspace owners and admins. Ask an administrator to grant analytics access, then reload this page."
      />
    </div>
  );
}

/** Small inline spinner label used when keeping previous data during a refresh. */
export function RefreshingNotice(): JSX.Element {
  return (
    <p role="status" className="flex items-center gap-2 text-xs text-muted">
      <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
      Refreshing analytics…
    </p>
  );
}
