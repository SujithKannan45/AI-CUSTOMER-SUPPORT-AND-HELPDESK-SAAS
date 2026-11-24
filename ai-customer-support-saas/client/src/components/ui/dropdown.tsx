import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { cn } from '@/utils/cn.util';

export interface DropdownItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly onSelect: () => void;
  readonly tone?: 'default' | 'danger';
  readonly disabled?: boolean;
}

export interface DropdownProps {
  /** Accessible name for the trigger and menu. */
  label: string;
  /** Trigger content (text, avatar, icon). The trigger itself is rendered by Dropdown. */
  trigger: ReactNode;
  items: readonly DropdownItem[];
  align?: 'start' | 'end';
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  /** Optional non-interactive block at the top of the menu (e.g. identity). */
  header?: ReactNode;
}

/**
 * Menu button (WAI-ARIA menu button pattern): click/ArrowDown opens, arrow
 * keys move between items, Home/End jump, Escape closes and restores focus to
 * the trigger, outside clicks dismiss. Items are focusable buttons rendered
 * with `role="menuitem"`, so Enter/Space activate natively.
 */
export function Dropdown({
  label,
  trigger,
  items,
  align = 'end',
  className,
  triggerClassName,
  menuClassName,
  header,
}: DropdownProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const baseId = useId();
  const menuId = `${baseId}-menu`;

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const enabledItems = useCallback(
    (): HTMLButtonElement[] =>
      itemRefs.current.filter((element): element is HTMLButtonElement => element !== null && !element.disabled),
    [],
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (containerRef.current !== null && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      enabledItems()[0]?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, enabledItems]);

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const focusable = enabledItems();
    const currentIndex = focusable.findIndex((element) => element === document.activeElement);
    const lastIndex = focusable.length - 1;

    const focusAt = (index: number): void => {
      focusable[(index + focusable.length) % focusable.length]?.focus();
    };

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusAt(currentIndex < 0 ? 0 : currentIndex + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusAt(currentIndex < 0 ? lastIndex : currentIndex - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusAt(0);
        break;
      case 'End':
        event.preventDefault();
        focusAt(lastIndex);
        break;
      case 'Escape':
        event.preventDefault();
        close(true);
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <div ref={containerRef} className={cn('relative inline-block text-left', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            if (!open) {
              event.preventDefault();
              setOpen(true);
            }
          }
        }}
        className={cn(
          'inline-flex items-center gap-2 rounded-lg transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          triggerClassName,
        )}
      >
        {trigger}
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={handleMenuKeyDown}
          className={cn(
            'absolute z-tooltip mt-2 min-w-56 rounded-xl border border-border bg-surface p-1.5 shadow-popover',
            align === 'end' ? 'right-0' : 'left-0',
            menuClassName,
          )}
        >
          {header !== undefined ? <div className="border-b border-border px-2.5 pb-2 mb-1">{header}</div> : null}
          {items.map((item, index) => (
            <button
              key={item.id}
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={item.disabled === true}
              onClick={() => {
                close();
                item.onSelect();
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50',
                item.tone === 'danger'
                  ? 'text-danger hover:bg-danger-soft'
                  : 'text-foreground hover:bg-surface-hover',
              )}
            >
              {item.icon !== undefined ? (
                <span aria-hidden className="shrink-0 text-muted">
                  {item.icon}
                </span>
              ) : null}
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
