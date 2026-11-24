import type { JSX, ReactNode } from 'react';
import { cn } from '@/utils/cn.util';
import { fieldDescriptionId, fieldErrorId } from './field-ids';

export interface FieldProps {
  /** Control id — also used to derive the description/error ids. */
  id: string;
  label: string;
  description?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * Form field wrapper: label, optional description, optional error message.
 *
 * The control stays a real input owned by the caller. Wire the ARIA
 * relationships with `fieldDescribedBy(id, { description, error })` from
 * `./field-ids` so the description and error are announced together, in order.
 */
export function Field({ id, label, description, error, required = false, children, className }: FieldProps): JSX.Element {
  return (
    <div className={cn('space-y-1.5', className)}>
      <FieldLabel htmlFor={id} required={required}>
        {label}
      </FieldLabel>
      {children}
      <FieldDescription id={fieldDescriptionId(id)}>{description}</FieldDescription>
      <FieldError id={fieldErrorId(id)} message={error} />
    </div>
  );
}

export function FieldLabel({ htmlFor, required = false, children }: { htmlFor: string; required?: boolean; children: string }): JSX.Element {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-medium text-foreground">
      {children}
      {required ? (
        <>
          <span aria-hidden className="ml-0.5 text-danger">
            *
          </span>
          <span className="sr-only"> (required)</span>
        </>
      ) : null}
    </label>
  );
}

export function FieldDescription({ id, children }: { id: string; children?: ReactNode }): JSX.Element | null {
  if (children === undefined) return null;
  return (
    <p id={id} className="text-xs leading-5 text-muted">
      {children}
    </p>
  );
}

export function FieldError({ id, message }: { id: string; message?: string }): JSX.Element | null {
  if (message === undefined || message.length === 0) return null;
  return (
    <p id={id} role="alert" className="text-xs font-medium text-danger">
      {message}
    </p>
  );
}
