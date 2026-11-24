import type { JSX, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { cn } from '@/utils/cn.util';
import type { ToastRecord, ToastTone } from './toast-context';

const TONE_ICON: Record<ToastTone, ReactNode> = {
  success: <CheckCircle2 aria-hidden className="h-4 w-4" />,
  error: <XCircle aria-hidden className="h-4 w-4" />,
  warning: <AlertTriangle aria-hidden className="h-4 w-4" />,
  info: <Info aria-hidden className="h-4 w-4" />,
};

const TONE_CLASS: Record<ToastTone, string> = {
  success: 'text-success',
  error: 'text-danger',
  warning: 'text-warning',
  info: 'text-info',
};

export interface ToastViewportProps {
  toasts: readonly ToastRecord[];
  onDismiss: (id: string) => void;
}

/**
 * Live region for transient feedback. `aria-live="polite"` announces new
 * toasts without interrupting the user mid-typing; each toast also offers an
 * explicit close button so a message never traps the reader.
 */
export function ToastViewport({ toasts, onDismiss }: ToastViewportProps): JSX.Element | null {
  if (toasts.length === 0 || typeof document === 'undefined') return null;

  return createPortal(
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-toast flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-0 sm:items-end"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-border bg-surface p-3.5 shadow-popover"
        >
          <span className={cn('mt-0.5 shrink-0', TONE_CLASS[toast.tone])}>{TONE_ICON[toast.tone]}</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{toast.title}</p>
            {toast.description !== undefined ? (
              <p className="mt-0.5 text-xs leading-5 text-muted">{toast.description}</p>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => onDismiss(toast.id)}
            className="rounded-md p-1 text-muted transition-colors duration-150 hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
