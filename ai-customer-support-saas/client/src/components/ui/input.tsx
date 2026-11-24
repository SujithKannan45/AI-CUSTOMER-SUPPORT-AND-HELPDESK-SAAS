import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/utils/cn.util';

const FIELD_BASE =
  'w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted transition-colors duration-150 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-soft disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-muted';

const INVALID = 'border-danger focus:border-danger focus:ring-danger-soft';

export type InputProps = InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean };

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid = false, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(FIELD_BASE, 'h-9', invalid && INVALID, className)}
      aria-invalid={invalid || undefined}
      {...props}
    />
  );
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean };

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid = false, rows = 3, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(FIELD_BASE, 'min-h-20 resize-y', invalid && INVALID, className)}
      aria-invalid={invalid || undefined}
      {...props}
    />
  );
});
