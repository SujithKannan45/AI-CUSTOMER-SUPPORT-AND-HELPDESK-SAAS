import type { JSX, ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime } from '@/utils/format-date.util';
import { assigneeLabel } from '../labels';
import type { TicketDto } from '../types';

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 py-2 first:pt-0 last:pb-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-right text-sm text-foreground">{children}</dd>
    </div>
  );
}

export interface TicketDetailsProps {
  readonly ticket: TicketDto;
}

/**
 * Ticket body and record details.
 *
 * `description` and `resolutionNote` are plain text written by staff: they are
 * rendered as text nodes inside `whitespace-pre-wrap`, never as HTML, so markup
 * in a ticket can never become executable content.
 */
export function TicketDetails({ ticket }: TicketDetailsProps): JSX.Element {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Description</CardTitle>
            <CardDescription>Submitted with the ticket · plain text</CardDescription>
          </div>
        </CardHeader>
        <CardBody>
          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
            {ticket.description}
          </p>
        </CardBody>
      </Card>

      {ticket.resolutionNote !== null ? (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Resolution note</CardTitle>
              <CardDescription>
                Recorded {formatDateTime(ticket.resolvedAt)} UTC
              </CardDescription>
            </div>
          </CardHeader>
          <CardBody>
            <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
              {ticket.resolutionNote}
            </p>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardBody>
          <dl className="divide-y divide-border">
            <Field label="Category">{ticket.category ?? '—'}</Field>
            <Field label="Tags">
              {ticket.tags.length === 0 ? (
                '—'
              ) : (
                <span className="flex flex-wrap justify-end gap-1">
                  {ticket.tags.map((tag) => (
                    <Badge key={tag} tone="neutral">
                      {tag}
                    </Badge>
                  ))}
                </span>
              )}
            </Field>
            <Field label="Due">{formatDateTime(ticket.dueAt)}</Field>
            <Field label="Resolved">{formatDateTime(ticket.resolvedAt)}</Field>
            <Field label="Closed">{formatDateTime(ticket.closedAt)}</Field>
            <Field label="Assignee">
              <span className="font-mono text-xs" {...(ticket.agentId !== null ? { title: ticket.agentId } : {})}>
                {assigneeLabel(ticket.agentId)}
              </span>
            </Field>
            <Field label="Opened by">
              <span className="font-mono text-xs" title={ticket.createdById}>
                Agent #{ticket.createdById.slice(-6)}
              </span>
            </Field>
            <Field label="Ticket ID">
              <span className="font-mono text-xs">{ticket.id}</span>
            </Field>
            {ticket.archivedAt !== null ? (
              <Field label="Archived">{formatDateTime(ticket.archivedAt)}</Field>
            ) : null}
          </dl>
        </CardBody>
      </Card>
    </div>
  );
}
