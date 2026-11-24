import type { HTMLAttributes, JSX, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '@/utils/cn.util';

/** Horizontally scrollable table surface — never breaks page layout on mobile. */
export function Table({ caption, className, children }: { caption?: string; className?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="w-full overflow-x-auto rounded-xl border border-border bg-surface">
      <table className={cn('w-full border-collapse text-left text-sm', className)}>
        {caption !== undefined ? <caption className="sr-only">{caption}</caption> : null}
        {children}
      </table>
    </div>
  );
}

export function TableHeader({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>): JSX.Element {
  return (
    <thead
      className={cn('bg-surface-subtle text-xs font-semibold uppercase tracking-wide text-muted', className)}
      {...props}
    />
  );
}

export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>): JSX.Element {
  return <tbody className={cn('divide-y divide-border', className)} {...props} />;
}

export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>): JSX.Element {
  return <tr className={cn('transition-colors duration-150 hover:bg-surface-hover', className)} {...props} />;
}

export function TableHead({ className, scope = 'col', ...props }: ThHTMLAttributes<HTMLTableCellElement>): JSX.Element {
  return <th scope={scope} className={cn('whitespace-nowrap px-4 py-2.5 font-semibold', className)} {...props} />;
}

export function TableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>): JSX.Element {
  return <td className={cn('px-4 py-3 align-middle text-foreground', className)} {...props} />;
}

/** Row spanning all columns for empty/loading feedback inside a table. */
export function TableMessageRow({ colSpan, children }: { colSpan: number; children: ReactNode }): JSX.Element {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-10 text-center text-sm text-muted">
        {children}
      </td>
    </tr>
  );
}
