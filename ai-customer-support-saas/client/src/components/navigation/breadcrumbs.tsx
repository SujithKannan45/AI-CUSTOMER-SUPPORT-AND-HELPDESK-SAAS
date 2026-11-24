import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/utils/cn.util';

export interface BreadcrumbItem {
  readonly label: string;
  /** Links are omitted for the final (current) crumb. */
  readonly to?: string;
}

/** Route-agnostic breadcrumb trail; pages supply their own items. */
export function Breadcrumbs({ items, className }: { items: readonly BreadcrumbItem[]; className?: string }): JSX.Element | null {
  if (items.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li key={`${item.label}-${String(index)}`} className="flex items-center gap-1.5">
              {index > 0 ? <ChevronRight aria-hidden className="h-3 w-3 text-border-strong" /> : null}
              {item.to !== undefined && !isLast ? (
                <Link to={item.to} className="rounded transition-colors duration-150 hover:text-foreground">
                  {item.label}
                </Link>
              ) : (
                <span aria-current={isLast ? 'page' : undefined} className={cn(isLast && 'font-medium text-foreground')}>
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
