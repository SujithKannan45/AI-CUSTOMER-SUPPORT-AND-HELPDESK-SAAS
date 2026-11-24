import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import { ToastViewport } from '@/components/ui/toast';
import { ToastContext, type ToastApi, type ToastOptions, type ToastRecord } from '@/components/ui/toast-context';

const DEFAULT_DURATION_MS = 5_000;
const MAX_VISIBLE_TOASTS = 4;

function createId(): string {
  return `toast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * App-wide toast queue. Toasts are transient UI state, so they live in React
 * state (not the global store) and auto-dismiss with per-toast timers that are
 * cleared on unmount.
 */
export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const timers = useRef(new Map<string, number>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const toast = useCallback(
    (options: ToastOptions): string => {
      const id = createId();
      const record: ToastRecord = {
        id,
        title: options.title,
        tone: options.tone ?? 'info',
        durationMs: options.durationMs ?? DEFAULT_DURATION_MS,
        ...(options.description !== undefined ? { description: options.description } : {}),
      };

      setToasts((current) => [...current.slice(-(MAX_VISIBLE_TOASTS - 1)), record]);

      if (record.durationMs > 0) {
        timers.current.set(
          id,
          window.setTimeout(() => dismiss(id), record.durationMs),
        );
      }

      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const value = useMemo<ToastApi>(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}
