import { forwardRef, type ButtonHTMLAttributes, type JSX, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { cn } from '@/utils/cn.util';
import { buttonVariants, type ButtonStyleProps } from './button-styles';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, ButtonStyleProps {
  /** Shows a spinner and disables interaction while an action is in flight. */
  isLoading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

/**
 * Primary action control. Always renders `type="button"` unless told
 * otherwise, so a button inside a form never submits by accident.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, isLoading = false, leftIcon, rightIcon, disabled, children, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled === true || isLoading}
      aria-busy={isLoading || undefined}
      {...props}
    >
      {isLoading ? <Loader2 aria-hidden className="h-4 w-4 animate-pulse" /> : leftIcon}
      {children}
      {rightIcon}
    </button>
  );
});

export type ButtonLinkProps = LinkProps & ButtonStyleProps;

/** A router link that looks like a button (real anchor semantics, not a nested button). */
export function ButtonLink({ className, variant, size, ...props }: ButtonLinkProps): JSX.Element {
  return <Link className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
