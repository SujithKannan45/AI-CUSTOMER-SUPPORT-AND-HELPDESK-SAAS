import type { JSX, ReactNode } from 'react';
import { cn } from '@/utils/cn.util';

export type BadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info';
export type BadgeAppearance = 'soft' | 'solid' | 'outline';

const SOFT: Record<BadgeTone, string> = {
  neutral: 'bg-surface-hover text-muted',
  brand: 'bg-primary-soft text-primary',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
};

const SOLID: Record<BadgeTone, string> = {
  neutral: 'bg-foreground text-surface',
  brand: 'bg-primary text-primary-foreground',
  success: 'bg-success text-surface',
  warning: 'bg-warning text-surface',
  danger: 'bg-danger text-danger-foreground',
  info: 'bg-info text-surface',
};

const OUTLINE: Record<BadgeTone, string> = {
  neutral: 'border border-border-strong text-muted',
  brand: 'border border-primary text-primary',
  success: 'border border-success text-success',
  warning: 'border border-warning text-warning',
  danger: 'border border-danger text-danger',
  info: 'border border-info text-info',
};

export interface BadgeProps {
  tone?: BadgeTone;
  appearance?: BadgeAppearance;
  /** Adds a small status dot (colour is never the only signal — the label stays). */
  dot?: boolean;
  className?: string;
  children: ReactNode;
}

/** Small status pill for tickets, priorities and flags. */
export function Badge({ tone = 'neutral', appearance = 'soft', dot = false, className, children }: BadgeProps): JSX.Element {
  const styles = appearance === 'solid' ? SOLID[tone] : appearance === 'outline' ? OUTLINE[tone] : SOFT[tone];

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium',
        styles,
        className,
      )}
    >
      {dot ? <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}
