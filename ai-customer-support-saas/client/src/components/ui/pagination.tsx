import type { JSX } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/utils/cn.util';
import { Button } from './button';

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  disabled?: boolean;
  /** Noun for the summary line, e.g. "tickets". */
  itemLabel?: string;
  className?: string;
}

/** Sliding window of up to five page numbers around the current page. */
function pageWindow(current: number, pageCount: number): number[] {
  if (pageCount <= 5) return Array.from({ length: pageCount }, (_, index) => index + 1);
  const start = Math.min(Math.max(current - 2, 1), pageCount - 4);
  return [start, start + 1, start + 2, start + 3, start + 4];
}

/**
 * Pagination foundation for every list endpoint (`page`/`limit`/`total`).
 * Server-side pagination is the rule: this component only reports intent.
 */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  disabled = false,
  itemLabel = 'results',
  className,
}: PaginationProps): JSX.Element {
  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const current = Math.min(Math.max(1, page), pageCount);
  const firstItem = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const lastItem = Math.min(current * pageSize, total);
  const isFirst = current <= 1;
  const isLast = current >= pageCount;

  return (
    <nav
      aria-label="Pagination"
      className={cn('flex flex-wrap items-center justify-between gap-3', className)}
    >
      <p className="text-xs text-muted" aria-live="polite">
        Showing <span className="font-medium text-foreground">{firstItem}</span>–
        <span className="font-medium text-foreground">{lastItem}</span> of{' '}
        <span className="font-medium text-foreground">{total}</span> {itemLabel}
      </p>

      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(current - 1)}
          disabled={disabled || isFirst}
          aria-label="Previous page"
        >
          <ChevronLeft aria-hidden className="h-4 w-4" />
          <span className="hidden sm:inline">Previous</span>
        </Button>

        {pageWindow(current, pageCount).map((pageNumber) => (
          <Button
            key={pageNumber}
            variant={pageNumber === current ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => onPageChange(pageNumber)}
            disabled={disabled}
            aria-label={`Page ${pageNumber}`}
            aria-current={pageNumber === current ? 'page' : undefined}
            className="min-w-8 px-2"
          >
            {pageNumber}
          </Button>
        ))}

        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(current + 1)}
          disabled={disabled || isLast}
          aria-label="Next page"
        >
          <span className="hidden sm:inline">Next</span>
          <ChevronRight aria-hidden className="h-4 w-4" />
        </Button>
      </div>
    </nav>
  );
}
