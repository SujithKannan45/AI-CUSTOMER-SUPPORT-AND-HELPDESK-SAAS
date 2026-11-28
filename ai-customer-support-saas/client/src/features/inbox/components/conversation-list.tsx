import type { JSX } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Badge } from '@/components/ui/badge';
import { listRowVariants } from '@/components/common/motion';
import { cn } from '@/utils/cn.util';
import { formatDateTime } from '@/utils/format-date.util';
import {
  TICKET_PRIORITY_LABELS,
  TICKET_PRIORITY_TONES,
  TICKET_STATUS_LABELS,
  TICKET_STATUS_TONES,
  assigneeLabel,
} from '@/features/tickets/labels';
import type { TicketDto } from '@/features/tickets/types';

export interface ConversationListProps {
  readonly threads: readonly TicketDto[];
  readonly selectedId: string | null;
  readonly onSelect: (ticketId: string) => void;
}

/**
 * The conversation index.
 *
 * Rows are the workspace's tickets (a ticket has exactly ONE primary
 * conversation — see the backend's unique `{workspaceId, ticketId}` index), so
 * each row can show real status, priority, assignee and last activity from the
 * ticket DTO. The conversation DTO exposes no message preview, so no preview is
 * rendered — the subject stands in for it, exactly like an email inbox.
 *
 * Rows animate in with a capped stagger (see `listRowVariants`); selection is
 * communicated by `aria-current`, not by motion alone, and reduced-motion users
 * get the static list.
 */
export function ConversationList({
  threads,
  selectedId,
  onSelect,
}: ConversationListProps): JSX.Element {
  const prefersReducedMotion = useReducedMotion();

  return (
    <ul className="divide-y divide-border">
      {threads.map((ticket, index) => {
        const selected = ticket.id === selectedId;
        return (
          <motion.li
            key={ticket.id}
            variants={listRowVariants(prefersReducedMotion === true, index)}
            initial="hidden"
            animate="visible"
          >
            <button
              type="button"
              onClick={() => {
                onSelect(ticket.id);
              }}
              aria-current={selected ? 'true' : undefined}
              className={cn(
                'block w-full px-3 py-3 text-left transition-colors duration-150 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                selected && 'bg-primary-soft',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {ticket.subject}
                </span>
                <time
                  dateTime={ticket.updatedAt}
                  className="shrink-0 text-[11px] tabular-nums text-muted"
                >
                  {formatDateTime(ticket.updatedAt)}
                </time>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[11px] text-muted">{ticket.number}</span>
                <Badge tone={TICKET_STATUS_TONES[ticket.status]} dot>
                  {TICKET_STATUS_LABELS[ticket.status]}
                </Badge>
                <Badge tone={TICKET_PRIORITY_TONES[ticket.priority]}>
                  {TICKET_PRIORITY_LABELS[ticket.priority]}
                </Badge>
                <span className="truncate text-[11px] text-muted">
                  {assigneeLabel(ticket.agentId)}
                </span>
              </div>
            </button>
          </motion.li>
        );
      })}
    </ul>
  );
}
