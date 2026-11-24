import type { JSX } from 'react';
import { cn } from '@/utils/cn.util';

/** Decorative placeholder block; `aria-hidden` because the region reports its own state. */
export function Skeleton({ className }: { className?: string }): JSX.Element {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-surface-hover', className)} />;
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }): JSX.Element {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={cn('h-3.5', index === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}

export function SkeletonTable({ rows = 5, columns = 4 }: { rows?: number; columns?: number }): JSX.Element {
  return (
    <div className="w-full space-y-2 rounded-xl border border-border bg-surface p-4" aria-hidden>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div key={rowIndex} className="grid gap-4" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {Array.from({ length: columns }, (_, columnIndex) => (
            <Skeleton key={columnIndex} className="h-4" />
          ))}
        </div>
      ))}
    </div>
  );
}
