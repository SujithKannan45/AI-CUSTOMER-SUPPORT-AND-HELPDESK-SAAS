import { createContext } from 'react';

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Milliseconds before auto-dismiss; 0 keeps the toast until dismissed. */
  durationMs?: number;
}

export interface ToastRecord extends ToastOptions {
  id: string;
  tone: ToastTone;
  durationMs: number;
}

export interface ToastApi {
  /** Shows a toast and returns its id. */
  toast: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

/**
 * Context object lives outside the provider component file so the provider
 * module only exports a component (React Fast Refresh requirement) and the
 * `useToast` hook can live in `hooks/`.
 */
export const ToastContext = createContext<ToastApi | null>(null);
