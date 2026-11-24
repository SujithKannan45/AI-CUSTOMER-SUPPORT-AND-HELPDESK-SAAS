import { forwardRef, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/utils/cn.util';

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean };

/**
 * Native `<select>` styled to match the other fields — native wins on mobile
 * pickers, keyboard behaviour and screen-reader support, and it needs no
 * dependency. The chevron is decorative; the control keeps its own semantics.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, invalid = false, children, ...props },
  ref,
) {
  return (
    <span className="relative block">
      <select
        ref={ref}
        className={cn(
          'h-9 w-full appearance-none rounded-lg border border-border-strong bg-surface pl-3 pr-9 text-sm text-foreground transition-colors duration-150 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-soft disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-muted',
          invalid && 'border-danger focus:border-danger focus:ring-danger-soft',
          className,
        )}
        aria-invalid={invalid || undefined}
        {...props}
      >
        {children}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
    </span>
  );
});
