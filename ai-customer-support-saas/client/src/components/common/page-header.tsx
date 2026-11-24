import type { JSX, ReactNode } from 'react';
import { cn } from '@/utils/cn.util';
import { Breadcrumbs, type BreadcrumbItem } from '@/components/navigation/breadcrumbs';

export interface PageHeaderProps {
  title: string;
  description?: string;
  breadcrumbs?: readonly BreadcrumbItem[];
  actions?: ReactNode;
  className?: string;
}

/** Consistent page title block: breadcrumbs, heading, description, actions. */
export function PageHeader({ title, description, breadcrumbs, actions, className }: PageHeaderProps): JSX.Element {
  return (
    <header className={cn('space-y-3', className)}>
      {breadcrumbs !== undefined ? <Breadcrumbs items={breadcrumbs} /> : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">{title}</h1>
          {description !== undefined ? (
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">{description}</p>
          ) : null}
        </div>
        {actions !== undefined ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}
