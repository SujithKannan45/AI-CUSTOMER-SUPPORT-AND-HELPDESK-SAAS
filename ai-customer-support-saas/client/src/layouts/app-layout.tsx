import { useEffect, type JSX } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { cn } from '@/utils/cn.util';
import { useUiStore } from '@/store/ui.store';
import { useWorkspaceBootstrap } from '@/features/workspace/use-workspace';
import { Header } from './components/header';
import { Sidebar } from './components/sidebar';

/**
 * Application shell for every authenticated page.
 *
 * Desktop: sticky full-height sidebar + sticky header, content constrained to
 * a readable max width. Below `lg` the sidebar becomes an overlay drawer with
 * an explicit close affordance, Escape support and route-change auto-close.
 */
export function AppLayout(): JSX.Element {
  const isSidebarOpen = useUiStore((state) => state.sidebarOpen);
  const closeSidebar = useUiStore((state) => state.closeSidebar);
  const location = useLocation();
  useWorkspaceBootstrap();

  useEffect(() => {
    closeSidebar();
  }, [location.pathname, closeSidebar]);

  useEffect(() => {
    if (!isSidebarOpen) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeSidebar();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isSidebarOpen, closeSidebar]);

  return (
    <div className="min-h-dvh lg:flex">
      <a
        href="#main-content"
        className="sr-only rounded-lg bg-surface px-3 py-2 text-sm font-medium text-foreground shadow-popover focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-toast"
      >
        Skip to content
      </a>

      {isSidebarOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={closeSidebar}
          className="fixed inset-0 z-overlay cursor-default bg-overlay lg:hidden"
        />
      ) : null}

      <aside
        id="app-sidebar"
        aria-label="Sidebar"
        className={cn(
          'fixed inset-y-0 left-0 z-drawer flex w-64 shrink-0 flex-col border-r border-border bg-surface transition-transform duration-200 ease-standard lg:sticky lg:top-0 lg:h-dvh lg:translate-x-0',
          isSidebarOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <Sidebar onNavigate={closeSidebar} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <Header />
        <main id="main-content" tabIndex={-1} className="flex-1 px-4 py-6 focus-visible:outline-none lg:px-8 lg:py-8">
          <div className="mx-auto w-full max-w-7xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
