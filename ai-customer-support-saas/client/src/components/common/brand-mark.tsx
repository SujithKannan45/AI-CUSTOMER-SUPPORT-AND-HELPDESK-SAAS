import type { JSX } from 'react';
import { Headset } from 'lucide-react';
import { cn } from '@/utils/cn.util';
import { clientEnv } from '@/config/env.config';

/** Product identity mark (brand tile + name), used on public/auth screens. */
export function BrandMark({ className, subtitle }: { className?: string; subtitle?: string }): JSX.Element {
  return (
    <div className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <Headset aria-hidden className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold tracking-tight text-foreground">
          {clientEnv.appName}
        </span>
        {subtitle !== undefined ? (
          <span className="block truncate text-xs text-muted">{subtitle}</span>
        ) : null}
      </span>
    </div>
  );
}
