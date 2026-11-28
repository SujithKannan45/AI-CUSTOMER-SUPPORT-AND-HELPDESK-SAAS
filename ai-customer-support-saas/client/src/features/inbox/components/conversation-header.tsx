import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { ticketPath, customerPath } from '@/app/routes/route-paths';
import { formatDateTime } from '@/utils/format-date.util';
import { useCustomerDetail } from '@/features/customers/use-customer-detail';
import { CUSTOMER_STATUS_LABELS, CUSTOMER_STATUS_TONES } from '@/features/customers/labels';
import {
  TICKET_PRIORITY_LABELS,
  TICKET_PRIORITY_TONES,
  TICKET_STATUS_LABELS,
  TICKET_STATUS_TONES,
  assigneeLabel,
} from '@/features/tickets/labels';
import type { TicketDto } from '@/features/tickets/types';
import type { ConversationDto } from '../types';

export interface ConversationHeaderProps {
  readonly workspaceId: string;
  readonly ticket: TicketDto;
  readonly conversation: ConversationDto | null;
  readonly showBack: boolean;
  readonly onBack: () => void;
}

/**
 * Conversation header: the thread's identity (ticket number + subject), the
 * ticket's real lifecycle state, the linked customer (one supported
 * `GET …/customers/:id` read) and links to the full records.
 *
 * Conversation-level status/assignment deliberately do not exist here: the
 * backend gives a conversation no lifecycle of its own — it follows its ticket,
 * whose state is displayed and whose actions live on the ticket page.
 */
export function ConversationHeader({
  workspaceId,
  ticket,
  conversation,
  showBack,
  onBack,
}: ConversationHeaderProps): JSX.Element {
  const customer = useCustomerDetail(workspaceId, ticket.customerId);

  return (
    <header className="space-y-3 border-b border-border bg-surface px-3 py-3">
      <div className="flex items-start gap-2">
        {showBack ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={onBack}
            aria-label="Back to conversation list"
            className="-ml-1 shrink-0 lg:hidden"
          >
            <ArrowLeft aria-hidden className="h-4 w-4" />
          </Button>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[11px] text-muted">{ticket.number}</span>
            <Badge tone={TICKET_STATUS_TONES[ticket.status]} dot>
              {TICKET_STATUS_LABELS[ticket.status]}
            </Badge>
            <Badge tone={TICKET_PRIORITY_TONES[ticket.priority]}>
              {TICKET_PRIORITY_LABELS[ticket.priority]}
            </Badge>
            <span className="text-[11px] text-muted">{assigneeLabel(ticket.agentId)}</span>
          </div>
          <h2 className="mt-1 truncate text-base font-semibold tracking-tight text-foreground">
            {ticket.subject}
          </h2>
        </div>
        <ButtonLink
          to={ticketPath(ticket.id)}
          variant="outline"
          size="sm"
          className="shrink-0"
          aria-label={`Open ticket ${ticket.number}`}
        >
          Ticket
          <ExternalLink aria-hidden className="ml-1 h-3.5 w-3.5" />
        </ButtonLink>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted">
        {customer.status === 'ready' && customer.customer !== null ? (
          <span className="flex min-w-0 items-center gap-2">
            <Avatar name={customer.customer.name} src={customer.customer.avatarUrl ?? undefined} size="xs" />
            <Link
              to={customerPath(customer.customer.id)}
              className="truncate text-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {customer.customer.name}
            </Link>
            <Badge tone={CUSTOMER_STATUS_TONES[customer.customer.status]}>
              {CUSTOMER_STATUS_LABELS[customer.customer.status]}
            </Badge>
          </span>
        ) : customer.status === 'loading' ? (
          <Skeleton className="h-4 w-32" />
        ) : (
          // Archived/forbidden/unknown customer: a real, plainly stated gap.
          <span>Customer record unavailable</span>
        )}

        <span aria-hidden>·</span>
        <span>
          Last message{' '}
          <time dateTime={conversation?.lastMessageAt ?? ticket.updatedAt}>
            {formatDateTime(conversation?.lastMessageAt ?? ticket.updatedAt)}
          </time>{' '}
          UTC
        </span>
        {conversation !== null ? (
          <>
            <span aria-hidden>·</span>
            <span>
              Conversation started <time dateTime={conversation.createdAt}>{formatDateTime(conversation.createdAt)}</time> UTC
            </span>
          </>
        ) : null}
      </div>
    </header>
  );
}
