import { useId, type JSX } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/utils/cn.util';

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Called on Enter / form submit — pair with `useDebounce` for live search. */
  onSubmit?: () => void;
  label?: string;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

/** Search field with a leading icon and a clear button. */
export function SearchInput({
  value,
  onChange,
  onSubmit,
  label = 'Search',
  placeholder = 'Search…',
  id,
  disabled = false,
  className,
}: SearchInputProps): JSX.Element {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <form
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.();
      }}
      className={cn('relative', className)}
    >
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
      <input
        id={inputId}
        type="search"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-lg border border-border-strong bg-surface pl-9 pr-9 text-sm text-foreground placeholder:text-muted transition-colors duration-150 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-soft disabled:cursor-not-allowed disabled:bg-surface-subtle [&::-webkit-search-cancel-button]:appearance-none"
      />
      {value.length > 0 ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted transition-colors duration-150 hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X aria-hidden className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </form>
  );
}
