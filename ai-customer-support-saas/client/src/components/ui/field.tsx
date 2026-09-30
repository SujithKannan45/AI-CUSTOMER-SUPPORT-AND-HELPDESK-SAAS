import { forwardRef, type InputHTMLAttributes, type JSX, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/utils/cn.util';

const fieldBase =
  'w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200 disabled:cursor-not-allowed disabled:bg-ink-100';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  ({ className, invalid, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(fieldBase, invalid && 'border-danger focus:border-danger focus:ring-red-200', className)}
      aria-invalid={invalid}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  ({ className, invalid, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(fieldBase, 'min-h-24 resize-y', invalid && 'border-danger focus:border-danger focus:ring-red-200', className)}
      aria-invalid={invalid}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';

export function FieldLabel({ htmlFor, children }: { htmlFor: string; children: string }): JSX.Element {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-ink-700">
      {children}
    </label>
  );
}

export function FieldError({ id, message }: { id: string; message?: string }): JSX.Element | null {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1.5 text-xs text-danger">
      {message}
    </p>
  );
}
