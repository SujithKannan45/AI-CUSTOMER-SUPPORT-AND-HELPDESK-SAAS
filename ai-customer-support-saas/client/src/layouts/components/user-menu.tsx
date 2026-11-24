import type { JSX } from 'react';
import { LogOut } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Dropdown } from '@/components/ui/dropdown';
import { useSessionStore } from '@/features/auth/auth.store';
import { useSignOut } from '@/features/auth/use-sign-out';
import { useActiveWorkspace } from '@/features/workspace/use-workspace';
import { ROLE_LABELS } from '@/features/workspace/types';

/** Signed-in identity + account actions (sign-out is fully wired). */
export function UserMenu(): JSX.Element | null {
  const user = useSessionStore((state) => state.user);
  const { role } = useActiveWorkspace();
  const { signOut, isSigningOut } = useSignOut();

  if (user === null) return null;

  return (
    <Dropdown
      label={`Account menu for ${user.name}`}
      align="end"
      menuClassName="w-64"
      triggerClassName="rounded-full p-0.5 hover:bg-surface-hover"
      trigger={<Avatar name={user.name} src={user.avatarUrl} size="sm" />}
      header={
        <div className="flex items-start gap-2.5 px-1 py-1">
          <Avatar name={user.name} src={user.avatarUrl} size="md" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{user.name}</p>
            <p className="truncate text-xs text-muted">{user.email}</p>
            {role !== null ? (
              <span className="mt-1.5 inline-flex">
                <Badge tone="neutral">{ROLE_LABELS[role]}</Badge>
              </span>
            ) : null}
          </div>
        </div>
      }
      items={[
        {
          id: 'sign-out',
          label: isSigningOut ? 'Signing out…' : 'Sign out',
          icon: <LogOut className="h-4 w-4" />,
          tone: 'danger',
          disabled: isSigningOut,
          onSelect: () => {
            void signOut();
          },
        },
      ]}
    />
  );
}
