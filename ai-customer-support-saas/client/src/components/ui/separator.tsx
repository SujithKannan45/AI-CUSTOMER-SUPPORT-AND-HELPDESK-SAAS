import type { JSX, ReactNode } from 'react';
import { cn } from '@/utils/cn.util';

export interface SeparatorProps {
  orientation?: 'horizontal' | 'vertical';
  /** Optional centred label (horizontal only). */
  label?: ReactNode;
  className?: string;
}

export function Separator({ orientation = 'horizontal', label, className }: SeparatorProps): JSX.Element {
  if (orientation === 'vertical') {
    return <span role="separator" aria-orientation="vertical" className={cn('inline-block h-full w-px bg-border', className)} />;
  }

  if (label !== undefined) {
    return (
      <div role="separator" aria-orientation="horizontal" className={cn('flex items-center gap-3', className)}>
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }

  return <div role="separator" aria-orientation="horizontal" className={cn('h-px w-full bg-border', className)} />;
}
