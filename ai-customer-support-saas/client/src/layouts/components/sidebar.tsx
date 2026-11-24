import type { JSX } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { Headset } from 'lucide-react';
import { ROUTES } from '@/app/routes/route-paths';
import { clientEnv } from '@/config/env.config';
import { cn } from '@/utils/cn.util';
import { NAV_SECTIONS } from './nav-items';
import { WorkspaceSwitcher } from './workspace-switcher';

/** Sidebar content: brand, workspace identity, grouped navigation. */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }): JSX.Element {
  return (
    <>
      <div className="flex h-14 shrink-0 items-center border-b border-border px-4">
        <Link
          to={ROUTES.dashboard}
          onClick={onNavigate}
          className="flex min-w-0 items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Headset aria-hidden className="h-4 w-4" />
          </span>
          <span className="truncate text-sm font-semibold tracking-tight text-foreground">{clientEnv.appName}</span>
        </Link>
      </div>

      <div className="pt-3">
        <WorkspaceSwitcher />
      </div>

      <nav aria-label="Primary" className="flex-1 overflow-y-auto px-2 py-2">
        {NAV_SECTIONS.map((section) => (
          <div key={section.label} className="pt-3 first:pt-1">
            <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">{section.label}</p>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.to}>
                    {item.enabled ? (
                      <NavLink
                        to={item.to}
                        onClick={onNavigate}
                        className={({ isActive }) =>
                          cn(
                            'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors duration-150',
                            isActive
                              ? 'bg-primary-soft text-primary'
                              : 'text-muted hover:bg-surface-hover hover:text-foreground',
                          )
                        }
                      >
                        <Icon aria-hidden className="h-4 w-4 shrink-0" />
                        {item.label}
                      </NavLink>
                    ) : (
                      <span
                        aria-disabled="true"
                        title="Coming in a later phase"
                        className="flex cursor-not-allowed items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-muted/60"
                      >
                        <Icon aria-hidden className="h-4 w-4 shrink-0" />
                        {item.label}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <p className="shrink-0 border-t border-border px-4 py-3 text-[11px] leading-4 text-muted">
        Foundation build — features land phase by phase
      </p>
    </>
  );
}
