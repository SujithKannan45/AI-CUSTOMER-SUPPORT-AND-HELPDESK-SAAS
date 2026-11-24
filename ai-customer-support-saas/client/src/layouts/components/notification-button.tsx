import { useEffect, useState, type JSX } from 'react';
import { Bell } from 'lucide-react';
import { Tooltip } from '@/components/ui/tooltip';
import { useActiveWorkspace } from '@/features/workspace/use-workspace';
import { notificationService } from '@/features/notifications/notification.service';

/**
 * Notification access foundation: reads the caller's real unread count for the
 * active workspace. The inbox destination ships with a later prompt, so this
 * is an honest status indicator (not a link to a route that does not exist).
 */
export function NotificationButton(): JSX.Element {
  const { workspace } = useActiveWorkspace();
  const [unreadCount, setUnreadCount] = useState<number | null>(null);

  useEffect(() => {
    if (workspace === null) {
      setUnreadCount(null);
      return;
    }

    const controller = new AbortController();
    setUnreadCount(null);

    notificationService
      .getUnreadCount(workspace.id, { signal: controller.signal })
      .then((payload) => setUnreadCount(payload.unreadCount))
      .catch(() => {
        // A badge is decorative: failures stay silent and omit the count.
        setUnreadCount(null);
      });

    return () => controller.abort();
  }, [workspace]);

  const count = unreadCount ?? 0;
  const label = count > 0 ? `Notifications: ${String(count)} unread` : 'Notifications: none unread';
  const tooltip = count > 0 ? `${String(count)} unread notification${count === 1 ? '' : 's'}` : 'No unread notifications';

  return (
    <Tooltip content={tooltip} side="bottom">
      <span
        role="status"
        aria-label={label}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted"
      >
        <Bell aria-hidden className="h-4 w-4" />
        {count > 0 ? (
          <span
            aria-hidden
            className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-none text-danger-foreground"
          >
            {count > 99 ? '99+' : count}
          </span>
        ) : null}
      </span>
    </Tooltip>
  );
}
