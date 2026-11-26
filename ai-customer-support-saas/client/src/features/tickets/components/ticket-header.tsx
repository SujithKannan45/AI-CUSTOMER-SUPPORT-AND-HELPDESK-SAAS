import type { JSX } from 'react';
import { CheckCircle2, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Breadcrumbs } from '@/components/navigation/breadcrumbs';
import { ROUTES } from '@/app/routes/route-paths';
import { formatDateTime } from '@/utils/format-date.util';
import {
  TICKET_PRIORITY_LABELS,
  TICKET_PRIORITY_TONES,
  TICKET_STATUS_LABELS,
  TICKET_STATUS_TONES,
} from '../labels';
import type { TicketDto } from '../types';

export interface TicketHeaderProps {
  readonly ticket: TicketDto;
  readonly canModify: boolean;
  readonly isBusy: boolean;
  readonly onResolve: () => void;
  readonly onReopen: () => void;
}

/** Ticket identity block: number, subject, current state and lifecycle actions. */
export function TicketHeader({
  ticket,
  canModify,
  isBusy,
  onResolve,
  onReopen,
}: TicketHeaderProps): JSX.Element {
  const resolved = ticket.status === 'RESOLVED';
  const canReopen = ticket.status !== 'OPEN';

  return (
    <header className="space-y-3">
      <Breadcrumbs
        items={[{ label: 'Tickets', to: ROUTES.tickets }, { label: ticket.number }]}
      />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-medium text-muted">{ticket.number}</span>
            <Badge tone={TICKET_STATUS_TONES[ticket.status]} dot>
              {TICKET_STATUS_LABELS[ticket.status]}
            </Badge>
            <Badge tone={TICKET_PRIORITY_TONES[ticket.priority]} appearance="outline">
              {TICKET_PRIORITY_LABELS[ticket.priority]} priority
            </Badge>
            {ticket.archivedAt !== null ? (
              <Badge tone="neutral" appearance="outline">
                Archived
              </Badge>
            ) : null}
          </div>

          <h1 className="mt-1 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
            {ticket.subject}
          </h1>
          <p className="mt-1 text-xs text-muted">
            Created {formatDateTime(ticket.createdAt)} UTC · Updated{' '}
            {formatDateTime(ticket.updatedAt)} UTC
          </p>
        </div>

        {canModify ? (
          <div className="flex flex-wrap items-center gap-2">
            {!resolved ? (
              <Button
                size="sm"
                onClick={onResolve}
                disabled={isBusy}
                leftIcon={<CheckCircle2 aria-hidden className="h-3.5 w-3.5" />}
              >
                Resolve
              </Button>
            ) : null}
            {canReopen ? (
              <Button
                variant="outline"
                size="sm"
                onClick={onReopen}
                isLoading={isBusy}
                leftIcon={<RotateCcw aria-hidden className="h-3.5 w-3.5" />}
              >
                Reopen
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </header>
  );
}
