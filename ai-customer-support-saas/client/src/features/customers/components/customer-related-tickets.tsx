import { useEffect, useState, type JSX } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Ticket } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/feedback/states';
import { ticketPath } from '@/app/routes/route-paths';
import { ticketService } from '@/features/tickets/ticket.service';
import { TICKET_STATUS_LABELS, TICKET_STATUS_TONES } from '@/features/tickets/labels';
import type { TicketDto } from '@/features/tickets/types';
import { formatDate } from '@/utils/format-date.util';

type RelatedStatus = 'loading' | 'ready' | 'error';

export interface CustomerRelatedTicketsProps {
  readonly workspaceId: string;
  readonly customerId: string;
  /** How many recent tickets to show (server-side `limit`, max 50). */
  readonly limit?: number;
}

/**
 * Related tickets for one customer.
 *
 * Uses the supported `customerId` list filter — the backend has no dedicated
 * "customer tickets" endpoint, and the Prompt 15/8 ticket DTO carries the
 * customer reference, so this is the exact supported query rather than an
 * invented one. The list is capped and ordered newest-first by the server.
 */
export function CustomerRelatedTickets({
  workspaceId,
  customerId,
  limit = 5,
}: CustomerRelatedTicketsProps): JSX.Element {
  const [status, setStatus] = useState<RelatedStatus>('loading');
  const [tickets, setTickets] = useState<readonly TicketDto[]>([]);
  const [total, setTotal] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');

    void (async () => {
      try {
        const payload = await ticketService.list(
          workspaceId,
          { customerId, limit, sort: 'createdAt', order: 'desc', page: 1 },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setTickets(payload.items);
        setTotal(payload.total);
        setStatus('ready');
      } catch {
        if (controller.signal.aborted) return;
        setTickets([]);
        setTotal(0);
        setStatus('error');
      }
    })();

    return () => {
      controller.abort();
    };
  }, [workspaceId, customerId, limit, reloadToken]);

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Related tickets</CardTitle>
          <CardDescription>
            Tickets in this workspace linked to this customer
            {status === 'ready' && total > 0 ? ` · ${total} total` : ''}
          </CardDescription>
        </div>
        {status === 'ready' && total > tickets.length ? (
          <p className="text-xs text-muted">Showing the {tickets.length} most recent</p>
        ) : null}
      </CardHeader>
      <CardBody>
        {status === 'loading' ? (
          <div role="status" aria-live="polite" className="space-y-2">
            <span className="sr-only">Loading related tickets…</span>
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
        ) : status === 'error' ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p role="alert" className="text-sm text-muted">
              Related tickets could not be loaded.
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setReloadToken((token) => token + 1);
              }}
              leftIcon={<RefreshCw aria-hidden className="h-3.5 w-3.5" />}
            >
              Try again
            </Button>
          </div>
        ) : tickets.length === 0 ? (
          <EmptyState
            icon={<Ticket aria-hidden className="h-5 w-5" />}
            title="No tickets yet"
            message="This customer has no tickets in the current workspace."
          />
        ) : (
          <ul aria-label="Related tickets" className="divide-y divide-border">
            {tickets.map((ticket) => (
              <li key={ticket.id} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <Link
                    to={ticketPath(ticket.id)}
                    className="flex min-w-0 items-center gap-2 rounded text-sm font-medium text-foreground transition-colors duration-150 hover:text-primary hover:underline"
                  >
                    <span className="shrink-0 font-mono text-xs text-muted">{ticket.number}</span>
                    <span className="truncate">{ticket.subject}</span>
                  </Link>
                  <p className="mt-0.5 text-xs text-muted">Created {formatDate(ticket.createdAt)}</p>
                </div>
                <Badge tone={TICKET_STATUS_TONES[ticket.status]} dot>
                  {TICKET_STATUS_LABELS[ticket.status]}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
