import type { JSX } from 'react';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { TICKET_PRIORITY_LABELS, TICKET_STATUS_LABELS } from '../labels';
import { isTicketPriority, isTicketStatus } from '../ticket.service';
import {
  TICKET_PRIORITIES,
  statusTargetsFor,
  type TicketDto,
  type TicketPriority,
  type TicketStatus,
} from '../types';

export interface TicketControlsProps {
  readonly ticket: TicketDto;
  readonly canModify: boolean;
  readonly readOnlyReason: string | null;
  readonly isBusy: boolean;
  readonly onStatusChange: (status: TicketStatus) => void;
  readonly onPriorityChange: (priority: TicketPriority) => void;
}

/**
 * Status/priority editors.
 *
 * Status options are exactly the transitions the backend's lifecycle table
 * permits from the current state (`RESOLVED` is reached through the dedicated
 * resolve action so a resolution note can be recorded). Priority options are
 * the real enum minus the current value. Effects do not update optimistically:
 * the page refetches after the server confirms.
 */
export function TicketControls({
  ticket,
  canModify,
  readOnlyReason,
  isBusy,
  onStatusChange,
  onPriorityChange,
}: TicketControlsProps): JSX.Element {
  const targets = statusTargetsFor(ticket.status).filter((status) => status !== 'RESOLVED');
  const priorities = TICKET_PRIORITIES.filter((priority) => priority !== ticket.priority);

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Manage ticket</CardTitle>
          <CardDescription>
            {canModify
              ? 'Changes are validated by the server and audited.'
              : (readOnlyReason ?? 'You do not have permission to change this ticket.')}
          </CardDescription>
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        {canModify ? (
          <>
            <Field
              id="ticket-status"
              label="Status"
              description="Only transitions the server allows are listed."
            >
              <Select
                id="ticket-status"
                value=""
                disabled={isBusy || targets.length === 0}
                onChange={(event) => {
                  const value = event.target.value;
                  if (isTicketStatus(value)) onStatusChange(value);
                }}
              >
                <option value="">
                  {targets.length === 0 ? 'No further transitions' : 'Change status…'}
                </option>
                {targets.map((status) => (
                  <option key={status} value={status}>
                    {TICKET_STATUS_LABELS[status]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field id="ticket-priority" label="Priority">
              <Select
                id="ticket-priority"
                value=""
                disabled={isBusy}
                onChange={(event) => {
                  const value = event.target.value;
                  if (isTicketPriority(value)) onPriorityChange(value);
                }}
              >
                <option value="">Change priority…</option>
                {priorities.map((priority) => (
                  <option key={priority} value={priority}>
                    {TICKET_PRIORITY_LABELS[priority]}
                  </option>
                ))}
              </Select>
            </Field>

            <p className="text-xs leading-5 text-muted">
              Use <span className="font-medium text-foreground">Resolve</span> to set a resolution
              note. Reassignment is not available: this backend release has no member-directory
              endpoint to choose a valid assignee.
            </p>
          </>
        ) : (
          <dl className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-xs uppercase tracking-wide text-muted">Status</dt>
              <dd className="text-foreground">{TICKET_STATUS_LABELS[ticket.status]}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-xs uppercase tracking-wide text-muted">Priority</dt>
              <dd className="text-foreground">{TICKET_PRIORITY_LABELS[ticket.priority]}</dd>
            </div>
          </dl>
        )}
      </CardBody>
    </Card>
  );
}
