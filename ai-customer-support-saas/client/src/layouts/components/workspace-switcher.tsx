import type { JSX } from 'react';
import { Building2, ChevronDown } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Dropdown } from '@/components/ui/dropdown';
import { Skeleton } from '@/components/ui/skeleton';
import { useActiveWorkspace } from '@/features/workspace/use-workspace';
import { ROLE_LABELS } from '@/features/workspace/types';

/**
 * Workspace identity + switcher.
 *
 * Switching only changes which workspace the UI displays; every request is
 * still authorized server-side from the caller's membership row.
 */
export function WorkspaceSwitcher(): JSX.Element {
  const { items, workspace, role, status, setActive } = useActiveWorkspace();

  if (status === 'idle' || status === 'loading') {
    return <Skeleton className="mx-3 h-10" />;
  }

  if (workspace === null) {
    return (
      <div className="mx-3 rounded-lg border border-dashed border-border px-3 py-2 text-xs leading-5 text-muted">
        No workspace yet
      </div>
    );
  }

  return (
    <Dropdown
      className="mx-3 block"
      align="start"
      menuClassName="w-56"
      label={`Switch workspace (current: ${workspace.name})`}
      triggerClassName="w-full justify-between rounded-lg border border-border px-2 py-1.5 hover:bg-surface-hover"
      trigger={
        <>
          <Avatar name={workspace.name} size="sm" />
          <span className="min-w-0 flex-1 truncate text-left text-sm font-medium text-foreground">{workspace.name}</span>
          <ChevronDown aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted" />
        </>
      }
      header={
        <div className="flex items-center justify-between gap-2 px-1 py-0.5">
          <span className="text-[11px] uppercase tracking-wide text-muted">Your role</span>
          {role !== null ? <Badge tone="brand">{ROLE_LABELS[role]}</Badge> : null}
        </div>
      }
      items={items.map((item) => ({
        id: item.workspace.id,
        label: item.workspace.name,
        icon: <Building2 className="h-4 w-4" />,
        disabled: item.workspace.id === workspace.id,
        onSelect: () => {
          setActive(item.workspace.id);
        },
      }))}
    />
  );
}
