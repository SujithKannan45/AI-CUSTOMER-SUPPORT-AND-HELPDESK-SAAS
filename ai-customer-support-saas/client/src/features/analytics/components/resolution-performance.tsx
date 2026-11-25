import type { JSX } from 'react';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCount, formatDuration } from '@/features/analytics/format';
import type { PerformancePayload } from '@/features/analytics/types';

export interface ResolutionPerformanceProps {
  readonly performance: PerformancePayload;
}

function Metric({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
}): JSX.Element {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums tracking-tight text-foreground">{value}</dd>
      <dd className="mt-0.5 text-[11px] leading-4 text-muted">{hint}</dd>
    </div>
  );
}

/**
 * Backend-defined performance metrics. Durations are `resolvedAt − createdAt`
 * for tickets resolved inside the window; the first-reply metric counts only
 * the first public agent message (internal notes are excluded server-side).
 * The unavailable customer first-response metric is stated, not approximated.
 */
export function ResolutionPerformance({ performance }: ResolutionPerformanceProps): JSX.Element {
  const resolution = performance.resolutionTime;
  const reply = performance.firstStaffReply;
  const backlog = performance.backlog;

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Resolution performance</CardTitle>
          <CardDescription>Durations for tickets resolved in the selected period</CardDescription>
        </div>
      </CardHeader>
      <CardBody>
        <dl className="grid gap-5 sm:grid-cols-2">
          <Metric
            label="Average resolution"
            value={formatDuration(resolution.averageMs)}
            hint={
              resolution.count === 0
                ? 'No resolutions in this period'
                : `${formatCount(resolution.count)} tickets measured`
            }
          />
          <Metric
            label="Median resolution"
            value={formatDuration(resolution.medianMs)}
            hint={resolution.count === 0 ? 'No resolutions in this period' : 'Backend percentile (p50)'}
          />
          <Metric
            label="First staff reply"
            value={formatDuration(reply.averageMs)}
            hint={
              reply.conversations === 0
                ? 'No first replies in this period'
                : `${formatCount(reply.conversations)} conversations · public replies only`
            }
          />
          <Metric
            label="Unassigned backlog"
            value={formatCount(backlog.unassigned)}
            hint={`of ${formatCount(backlog.totalBacklog)} active tickets`}
          />
        </dl>

        <p className="mt-5 border-t border-border pt-3 text-[11px] leading-4 text-muted">
          Resolution time = resolvedAt − createdAt, excluding null and negative durations. Customer first-response
          time is not measurable in this deployment because no customer-sender messages exist yet.
        </p>
      </CardBody>
    </Card>
  );
}
