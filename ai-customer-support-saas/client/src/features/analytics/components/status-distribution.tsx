import type { JSX } from 'react';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCount } from '@/features/analytics/format';
import type { TicketStatus, TicketStatusCounts } from '@/features/analytics/types';
import { cn } from '@/utils/cn.util';

interface StatusRow {
  readonly status: TicketStatus;
  readonly label: string;
  readonly barClass: string;
}

/** Labels mirror the backend ticket status vocabulary exactly. */
const STATUS_ROWS: readonly StatusRow[] = [
  { status: 'OPEN', label: 'Open', barClass: 'bg-info' },
  { status: 'IN_PROGRESS', label: 'In progress', barClass: 'bg-warning' },
  { status: 'WAITING_FOR_CUSTOMER', label: 'Waiting for customer', barClass: 'bg-primary' },
  { status: 'RESOLVED', label: 'Resolved', barClass: 'bg-success' },
  { status: 'CLOSED', label: 'Closed', barClass: 'bg-foreground/40' },
];

export interface StatusDistributionProps {
  readonly byStatus: TicketStatusCounts;
}

/**
 * Current live-ticket mix. The backend groups every live ticket in the
 * workspace for this breakdown (it is not window-scoped), so the caption says
 * so instead of implying a date filter applies.
 */
export function StatusDistribution({ byStatus }: StatusDistributionProps): JSX.Element {
  const total = STATUS_ROWS.reduce((sum, row) => sum + byStatus[row.status], 0);
  const max = STATUS_ROWS.reduce((peak, row) => Math.max(peak, byStatus[row.status]), 0);

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Ticket status</CardTitle>
          <CardDescription>Current live tickets by status · not limited by the date range</CardDescription>
        </div>
        <p className="text-xs text-muted">
          <span className="font-semibold tabular-nums text-foreground">{formatCount(total)}</span> total
        </p>
      </CardHeader>
      <CardBody>
        {total === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center gap-1 text-center">
            <p className="text-sm font-medium text-foreground">No tickets yet</p>
            <p className="text-xs text-muted">Statuses appear here once the workspace has tickets.</p>
          </div>
        ) : (
          <ul aria-label="Tickets by status" className="space-y-3">
            {STATUS_ROWS.map((row) => {
              const count = byStatus[row.status];
              const width = max === 0 ? 0 : Math.round((count / max) * 100);
              return (
                <li key={row.status}>
                  <div className="mb-1 flex items-center justify-between gap-3 text-xs">
                    <span className="text-muted">{row.label}</span>
                    <span className="font-medium tabular-nums text-foreground">{formatCount(count)}</span>
                  </div>
                  <div aria-hidden className="h-2 overflow-hidden rounded-full bg-surface-hover">
                    <div className={cn('h-2 rounded-full transition-[width] duration-300', row.barClass)} style={{ width: `${width}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
