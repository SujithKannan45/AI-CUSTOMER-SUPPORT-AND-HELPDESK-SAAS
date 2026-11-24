import type { JSX } from 'react';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useUiStore } from '@/store/ui.store';
import { useActiveWorkspace } from '@/features/workspace/use-workspace';
import { NotificationButton } from './notification-button';
import { ThemeToggle } from './theme-toggle';
import { UserMenu } from './user-menu';

/** Sticky application header: mobile drawer trigger, workspace identity, utilities. */
export function Header(): JSX.Element {
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const { workspace } = useActiveWorkspace();

  return (
    <header className="sticky top-0 z-sticky flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface/85 px-4 backdrop-blur lg:px-8">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Open navigation"
        aria-controls="app-sidebar"
        onClick={toggleSidebar}
        className="lg:hidden"
      >
        <Menu aria-hidden className="h-5 w-5" />
      </Button>

      <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {workspace?.name ?? 'Workspace'}
      </p>

      <div className="flex items-center gap-1">
        <ThemeToggle />
        <NotificationButton />
        <Separator orientation="vertical" className="mx-1 h-5" />
        <UserMenu />
      </div>
    </header>
  );
}
