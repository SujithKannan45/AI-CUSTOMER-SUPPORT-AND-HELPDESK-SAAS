import type { JSX } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Headset, LayoutDashboard, LifeBuoy, Settings } from 'lucide-react';
import { cn } from '@/utils/cn.util';
import { clientEnv } from '@/config/env.config';
import { useUiStore } from '@/store/ui.store';

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: typeof LayoutDashboard;
  /** Routes appear here only once their feature phase lands. */
  readonly enabled: boolean;
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, enabled: true },
  { to: '/tickets', label: 'Tickets', icon: LifeBuoy, enabled: false },
  { to: '/conversations', label: 'Conversations', icon: Headset, enabled: false },
  { to: '/settings', label: 'Settings', icon: Settings, enabled: false },
];

/** Primary application chrome: brand, navigation, responsive drawer. */
export function AppLayout(): JSX.Element {
  const isSidebarOpen = useUiStore((state) => state.sidebarOpen);
  const closeSidebar = useUiStore((state) => state.closeSidebar);

  return (
    <div className="flex min-h-dvh">
      {isSidebarOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={closeSidebar}
          className="fixed inset-0 z-30 bg-ink-900/40 lg:hidden"
        />
      ) : null}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-ink-200 bg-white transition-transform duration-200 lg:static lg:translate-x-0',
          isSidebarOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center gap-2.5 border-b border-ink-100 px-5 py-4">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white">
            <Headset className="h-4.5 w-4.5" aria-hidden />
          </span>
          <span className="text-sm font-semibold text-ink-900">{clientEnv.appName}</span>
        </div>

        <nav aria-label="Primary" className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {NAV_ITEMS.map((item) =>
            item.enabled ? (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={closeSidebar}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-brand-50 text-brand-700'
                      : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900',
                  )
                }
              >
                <item.icon className="h-4.5 w-4.5" aria-hidden />
                {item.label}
              </NavLink>
            ) : (
              <span
                key={item.to}
                aria-disabled
                title="Coming in a later phase"
                className="flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-ink-400"
              >
                <item.icon className="h-4.5 w-4.5" aria-hidden />
                {item.label}
              </span>
            ),
          )}
        </nav>

        <div className="border-t border-ink-100 px-5 py-3 text-xs text-ink-400">
          Foundation build — features land phase by phase
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-ink-200 bg-white/80 px-4 backdrop-blur lg:px-8">
          <button
            type="button"
            onClick={useUiStore.getState().toggleSidebar}
            aria-label="Toggle navigation"
            className="rounded-lg p-2 text-ink-600 hover:bg-ink-100 lg:hidden"
          >
            <LayoutDashboard className="h-5 w-5" aria-hidden />
          </button>
          <p className="text-sm font-medium text-ink-500">Workspace: none yet</p>
        </header>

        <main className="flex-1 px-4 py-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
