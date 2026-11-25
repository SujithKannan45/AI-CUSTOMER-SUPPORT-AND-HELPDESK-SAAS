import type { JSX, ReactNode } from 'react';
import { CheckCircle2, Inbox, PlusCircle, Ticket, Timer, Users } from 'lucide-react';
import { Card, CardBody } from '@/components/ui/card';
import { formatCount, formatDuration } from '@/features/analytics/format';
import type { DashboardAnalytics } from '@/features/analytics/types';

export interface KpiCardProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly hint: string;
  readonly icon: ReactNode;
}

/** One KPI: label, real API value, and a hint that states its scope. */
export function KpiCard({ id, label, value, hint, icon }: KpiCardProps): JSX.Element {
  return (
    <Card>
      <CardBody className="space-y-1.5">
        <div className="flex items-start justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</p>
          <span aria-hidden className="text-muted">
            {icon}
          </span>
        </div>
        <p
          className="text-2xl font-semibold tabular-nums tracking-tight text-foreground"
          data-testid={`kpi-${id}`}
        >
          {value}
        </p>
        <p className="text-[11px] leading-4 text-muted">{hint}</p>
      </CardBody>
    </Card>
  );
}

export interface KpiGridProps {
  readonly data: DashboardAnalytics;
}

/**
 * Six KPIs, each traced to a backend field:
 * total/current counts are workspace-wide (the backend does not window them),
 * period counts and durations are scoped to the selected window, and the
 * backlog definition belongs to the performance endpoint.
 */
export function KpiGrid({ data }: KpiGridProps): JSX.Element {
  const { overview, tickets, performance } = data;

  return (
    <section aria-label="Key metrics" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <KpiCard
        id="total-tickets"
        label="Total tickets"
        value={formatCount(overview.tickets.total)}
        hint="All live tickets in this workspace"
        icon={<Ticket className="h-4 w-4" />}
      />
      <KpiCard
        id="backlog"
        label="Active backlog"
        value={formatCount(performance.backlog.totalBacklog)}
        hint="Current open, in-progress and waiting tickets"
        icon={<Inbox className="h-4 w-4" />}
      />
      <KpiCard
        id="created"
        label="Created in period"
        value={formatCount(tickets.tickets.createdInPeriod)}
        hint="Tickets created inside the selected window"
        icon={<PlusCircle className="h-4 w-4" />}
      />
      <KpiCard
        id="resolved"
        label="Resolved in period"
        value={formatCount(tickets.tickets.resolvedInPeriod)}
        hint="Tickets resolved inside the selected window"
        icon={<CheckCircle2 className="h-4 w-4" />}
      />
      <KpiCard
        id="resolution-time"
        label="Average resolution time"
        value={formatDuration(performance.resolutionTime.averageMs)}
        hint={
          performance.resolutionTime.count === 0
            ? 'No tickets were resolved in this window'
            : `Across ${formatCount(performance.resolutionTime.count)} resolved tickets`
        }
        icon={<Timer className="h-4 w-4" />}
      />
      <KpiCard
        id="customers"
        label="Customers"
        value={formatCount(overview.customers.total)}
        hint={`${formatCount(overview.customers.newInPeriod)} new in the selected period`}
        icon={<Users className="h-4 w-4" />}
      />
    </section>
  );
}
