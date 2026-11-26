import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableMessageRow,
  TableRow,
} from '@/components/ui/table';
import { ticketPath } from '@/app/routes/route-paths';
import { formatDate } from '@/utils/format-date.util';
import {
  TICKET_PRIORITY_LABELS,
  TICKET_PRIORITY_TONES,
  TICKET_STATUS_LABELS,
  TICKET_STATUS_TONES,
  assigneeLabel,
} from '../labels';
import type { TicketDto } from '../types';

export interface TicketTableProps {
  readonly tickets: readonly TicketDto[];
}

/**
 * Ticket list table.
 *
 * Columns are limited to fields the ticket DTO carries. Customer names are not
 * resolved here: the DTO exposes `customerId` only and there is no batch
 * customer lookup, so a per-row name would mean N extra requests. The detail
 * page resolves the single linked customer instead.
 */
export function TicketTable({ tickets }: TicketTableProps): JSX.Element {
  return (
    <Table caption="Tickets in the current workspace">
      <TableHeader>
        <TableRow>
          <TableHead>Ticket</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Priority</TableHead>
          <TableHead className="hidden md:table-cell">Assignee</TableHead>
          <TableHead className="hidden lg:table-cell">Created</TableHead>
          <TableHead>Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tickets.length === 0 ? (
          <TableMessageRow colSpan={6}>No tickets to show.</TableMessageRow>
        ) : (
          tickets.map((ticket) => (
            <TableRow key={ticket.id}>
              <TableCell>
                <div className="min-w-0">
                  <Link
                    to={ticketPath(ticket.id)}
                    className="block truncate font-medium text-foreground transition-colors duration-150 hover:text-primary hover:underline"
                  >
                    {ticket.subject}
                  </Link>
                  <p className="font-mono text-xs text-muted">{ticket.number}</p>
                </div>
              </TableCell>
              <TableCell>
                <Badge tone={TICKET_STATUS_TONES[ticket.status]} dot>
                  {TICKET_STATUS_LABELS[ticket.status]}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge tone={TICKET_PRIORITY_TONES[ticket.priority]} appearance="outline">
                  {TICKET_PRIORITY_LABELS[ticket.priority]}
                </Badge>
              </TableCell>
              <TableCell className="hidden whitespace-nowrap md:table-cell">
                <span
                  className={ticket.agentId === null ? 'text-xs text-muted' : 'font-mono text-xs text-foreground'}
                  {...(ticket.agentId !== null ? { title: ticket.agentId } : {})}
                >
                  {assigneeLabel(ticket.agentId)}
                </span>
              </TableCell>
              <TableCell className="hidden whitespace-nowrap lg:table-cell">
                {formatDate(ticket.createdAt)}
              </TableCell>
              <TableCell className="whitespace-nowrap">{formatDate(ticket.updatedAt)}</TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
