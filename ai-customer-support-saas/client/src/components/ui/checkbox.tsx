import { forwardRef, useId, type InputHTMLAttributes, type JSX, type ReactNode } from 'react';
import { cn } from '@/utils/cn.util';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  description?: string;
  invalid?: boolean;
}

/** Checkbox with an associated label and optional description. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, invalid = false, className, id, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const descriptionId = `${inputId}-description`;

  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      <input
        ref={ref}
        id={inputId}
        type="checkbox"
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-border-strong accent-primary disabled:cursor-not-allowed disabled:opacity-60',
          invalid && 'outline outline-1 outline-danger',
        )}
        aria-invalid={invalid || undefined}
        aria-describedby={description !== undefined ? descriptionId : undefined}
        {...props}
      />
      <div className="min-w-0">
        <label htmlFor={inputId} className="block cursor-pointer text-sm font-medium leading-5 text-foreground">
          {label}
        </label>
        {description !== undefined ? (
          <p id={descriptionId} className="mt-0.5 text-xs leading-5 text-muted">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
});

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  className?: string;
}

/** Accessible toggle (`role="switch"`), usable with Space/Enter. */
export function Switch({ checked, onCheckedChange, label, description, disabled = false, className }: SwitchProps): JSX.Element {
  const labelId = useId();
  const descriptionId = `${labelId}-description`;

  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <span id={labelId} className="block text-sm font-medium leading-5 text-foreground">
          {label}
        </span>
        {description !== undefined ? (
          <p id={descriptionId} className="mt-0.5 text-xs leading-5 text-muted">
            {description}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={description !== undefined ? descriptionId : undefined}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'bg-primary' : 'bg-border-strong',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'inline-block h-4 w-4 rounded-full bg-surface shadow-card transition-transform duration-150 ease-standard',
            checked ? 'translate-x-[1.125rem]' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  );
}
