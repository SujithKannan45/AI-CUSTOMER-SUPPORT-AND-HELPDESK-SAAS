import { cloneElement, isValidElement, useId, useState, type JSX, type ReactNode } from 'react';
import { cn } from '@/utils/cn.util';

export interface TooltipProps {
  content: ReactNode;
  /** Placement relative to the trigger. */
  side?: 'top' | 'bottom';
  children: ReactNode;
  className?: string;
}

interface TriggerProps {
  'aria-describedby'?: string;
}

/**
 * Lightweight tooltip: hover + keyboard focus, Escape dismisses, linked to the
 * trigger through `aria-describedby` so screen readers announce it.
 *
 * Deliberately dependency-free and not portal-based — for short hints attached
 * to visible controls. Content that needs to survive overflow clipping or
 * interactive children belongs in a Dropdown/Menu instead.
 */
export function Tooltip({ content, side = 'top', children, className }: TooltipProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();

  const trigger = isValidElement<TriggerProps>(children)
    ? cloneElement(children, {
        'aria-describedby': open ? tooltipId : undefined,
      })
    : children;

  return (
    <span
      className={cn('relative inline-flex', className)}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      {trigger}
      {open ? (
        <span
          role="tooltip"
          id={tooltipId}
          className={cn(
            'pointer-events-none absolute left-1/2 z-tooltip max-w-64 -translate-x-1/2 rounded-md bg-foreground px-2 py-1 text-center text-xs font-medium leading-5 text-surface shadow-popover',
            side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
          )}
        >
          {content}
        </span>
      ) : null}
    </span>
  );
}
