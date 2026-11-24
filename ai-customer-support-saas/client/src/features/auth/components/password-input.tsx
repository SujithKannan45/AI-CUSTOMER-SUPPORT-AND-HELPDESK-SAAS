import { forwardRef, useState, type JSX } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '@/utils/cn.util';
import { Input, type InputProps } from '@/components/ui/input';

/**
 * Password input with a show/hide toggle.
 *
 * The toggle is a real `type="button"` (never submits the form), has a name
 * that reflects its action, exposes state via `aria-pressed`, and keeps the
 * label/description/error wiring of the wrapped `Input` intact.
 */
export const PasswordInput = forwardRef<HTMLInputElement, InputProps>(function PasswordInput(
  { className, ...props },
  ref,
): JSX.Element {
  const [visible, setVisible] = useState(false);
  const label = visible ? 'Hide password' : 'Show password';

  return (
    <div className="relative">
      <Input
        ref={ref}
        type={visible ? 'text' : 'password'}
        className={cn('pr-11', className)}
        {...props}
      />
      <button
        type="button"
        aria-label={label}
        aria-pressed={visible}
        title={label}
        onClick={() => {
          setVisible((current) => !current);
        }}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {visible ? <EyeOff aria-hidden className="h-4 w-4" /> : <Eye aria-hidden className="h-4 w-4" />}
      </button>
    </div>
  );
});
