import { useId, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/utils/cn.util';

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly content: ReactNode;
  readonly disabled?: boolean;
  /** Optional count/short text shown next to the label. */
  readonly badge?: string;
}

export interface TabsProps {
  tabs: readonly TabItem[];
  /** Controlled value; omit for uncontrolled tabs. */
  value?: string;
  defaultValue?: string;
  onValueChange?: (tabId: string) => void;
  className?: string;
}

/**
 * Accessible tabs (WAI-ARIA tabs pattern): roving tabindex, Arrow keys, Home
 * and End move selection; panels are labelled by their tab.
 */
export function Tabs({ tabs, value, defaultValue, onValueChange, className }: TabsProps): JSX.Element {
  const baseId = useId();
  const [uncontrolled, setUncontrolled] = useState<string | undefined>(defaultValue ?? tabs[0]?.id);
  const activeId = value ?? uncontrolled ?? tabs[0]?.id;
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const select = (tabId: string): void => {
    if (value === undefined) setUncontrolled(tabId);
    onValueChange?.(tabId);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const enabled = tabs.filter((tab) => tab.disabled !== true);
    const currentIndex = enabled.findIndex((tab) => tab.id === activeId);
    const lastIndex = enabled.length - 1;
    let nextIndex: number | null = null;

    switch (event.key) {
      case 'ArrowRight':
        nextIndex = currentIndex >= lastIndex ? 0 : currentIndex + 1;
        break;
      case 'ArrowLeft':
        nextIndex = currentIndex <= 0 ? lastIndex : currentIndex - 1;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = lastIndex;
        break;
      default:
        return;
    }

    event.preventDefault();
    const next = nextIndex !== null ? enabled[nextIndex] : undefined;
    if (next === undefined) return;
    select(next.id);
    tabRefs.current[tabs.findIndex((tab) => tab.id === next.id)]?.focus();
  };

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0];

  return (
    <div className={className}>
      <div role="tablist" aria-orientation="horizontal" onKeyDown={handleKeyDown} className="flex overflow-x-auto border-b border-border">
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeTab?.id;
          return (
            <button
              key={tab.id}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`${baseId}-panel-${tab.id}`}
              tabIndex={isActive ? 0 : -1}
              disabled={tab.disabled === true}
              onClick={() => select(tab.id)}
              className={cn(
                '-mb-px inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
                isActive
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted hover:border-border-strong hover:text-foreground',
              )}
            >
              {tab.label}
              {tab.badge !== undefined ? (
                <span className="rounded-full bg-surface-hover px-1.5 py-0.5 text-[10px] font-semibold text-muted">{tab.badge}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      {activeTab !== undefined ? (
        <div
          role="tabpanel"
          id={`${baseId}-panel-${activeTab.id}`}
          aria-labelledby={`${baseId}-tab-${activeTab.id}`}
          tabIndex={0}
          className="pt-4 focus-visible:outline-none"
        >
          {activeTab.content}
        </div>
      ) : null}
    </div>
  );
}
