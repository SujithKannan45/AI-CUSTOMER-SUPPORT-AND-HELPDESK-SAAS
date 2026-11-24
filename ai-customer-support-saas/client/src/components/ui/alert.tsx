import type { JSX, ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { cn } from '@/utils/cn.util';

export type AlertTone = 'error' | 'success' | 'warning' | 'info';

const TONES: Record<AlertTone, { container: string; icon: string }> = {
  error: { container: 'border-danger/30 bg-danger-soft text-danger', icon: 'text-danger' },
  success: { container: 'border-success/30 bg-success-soft text-success', icon: 'text-success' },
  warning: { container: 'border-warning/30 bg-warning-soft text-warning', icon: 'text-warning' },
  info: { container: 'border-info/30 bg-info-soft text-info', icon: 'text-info' },
};

const ICONS = {
  error: XCircle,
  success: CheckCircle2,
  warning: AlertTriangle,
  info: Info,
} as const;

export interface AlertProps {
  tone?: AlertTone;
  title?: string;
  children?: ReactNode;
  className?: string;
}

/**
 * Inline message block for form-level feedback.
 *
 * Errors are announced assertively (`role="alert"`); success/info states are
 * polite status updates. Text is the primary signal — the icon and colour only
 * reinforce it.
 */
export function Alert({ tone = 'info', title, children, className }: AlertProps): JSX.Element {
  const Icon = ICONS[tone];
  const styles = TONES[tone];

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm', styles.container, className)}
    >
      <Icon aria-hidden className={cn('mt-0.5 h-4 w-4 shrink-0', styles.icon)} />
      <div className="min-w-0 space-y-0.5">
        {title !== undefined ? <p className="font-medium">{title}</p> : null}
        {children !== undefined ? <div className="leading-5">{children}</div> : null}
      </div>
    </div>
  );
}
