import { useState, type JSX } from 'react';
import { Building2 } from 'lucide-react';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { PageTransition } from '@/components/common/page-transition';
import { DashboardForbiddenState, DashboardLoadingState } from '@/features/analytics/components/dashboard-states';
import { DashboardHeader } from '@/features/analytics/components/dashboard-header';
import { KpiGrid } from '@/features/analytics/components/kpi-grid';
import { ResolutionPerformance } from '@/features/analytics/components/resolution-performance';
import { StatusDistribution } from '@/features/analytics/components/status-distribution';
import { TicketTrendChart } from '@/features/analytics/components/ticket-trend-chart';
import { DEFAULT_SELECTION, type DashboardSelection } from '@/features/analytics/date-range';
import { useDashboardAnalytics } from '@/features/analytics/use-dashboard-analytics';
import type { DashboardAnalytics } from '@/features/analytics/types';
import { useActiveWorkspace } from '@/features/workspace/use-workspace';

function hasNoSupportActivity(data: DashboardAnalytics): boolean {
  return (
    data.overview.tickets.total === 0 &&
    data.overview.customers.total === 0 &&
    data.overview.conversations.total === 0
  );
}

/**
 * Workspace admin dashboard (Prompt 21).
 *
 * Reads only Prompt 18 analytics endpoints through the shared HTTP client, for
 * the workspace currently selected in the shell. The hook owns loading,
 * refresh, workspace-change invalidation and stale-response rejection; this
 * page owns the date selection and the page-level state switch.
 */
export function DashboardPage(): JSX.Element {
  const { workspace, role } = useActiveWorkspace();
  const [selection, setSelection] = useState<DashboardSelection>(DEFAULT_SELECTION);

  const analytics = useDashboardAnalytics({
    workspaceId: workspace?.id ?? null,
    preset: selection.kind === 'preset' ? selection.preset : 'custom',
    ...(selection.kind === 'custom' ? { customFrom: selection.from, customTo: selection.to } : {}),
  });

  const data = analytics.data;
  const period = data?.overview.period ?? null;
  const isBusy = analytics.status === 'loading' || analytics.status === 'refreshing';

  return (
    <PageTransition className="space-y-4">
      <DashboardHeader
        workspaceName={workspace?.name ?? 'No workspace'}
        role={role}
        selection={selection}
        onSelectionChange={setSelection}
        onRefresh={analytics.refresh}
        isRefreshing={isBusy}
        period={period}
        lastUpdated={analytics.lastUpdated}
      />

      {workspace === null ? (
        <div className="rounded-xl border border-border bg-surface">
          <EmptyState
            icon={<Building2 aria-hidden className="h-6 w-6" />}
            title="No workspace selected"
            message="Choose a workspace to load its analytics."
          />
        </div>
      ) : analytics.status === 'error' ? (
        analytics.forbidden ? (
          <DashboardForbiddenState />
        ) : (
          <ErrorState
            title="Analytics unavailable"
            message={analytics.error ?? 'The analytics data could not be loaded.'}
            onRetry={analytics.refresh}
          />
        )
      ) : data === null ? (
        <DashboardLoadingState />
      ) : hasNoSupportActivity(data) ? (
        <div className="rounded-xl border border-border bg-surface">
          <EmptyState
            title="No analytics yet"
            message="This workspace has no tickets or customers recorded yet. Metrics appear here as soon as support activity exists."
          />
        </div>
      ) : (
        <div className="space-y-4">
          <KpiGrid data={data} />
          <TicketTrendChart
            created={data.tickets.created}
            resolved={data.tickets.resolved}
            bucket={data.tickets.period.bucket}
          />
          <div className="grid gap-4 lg:grid-cols-2">
            <StatusDistribution byStatus={data.tickets.byStatus} />
            <ResolutionPerformance performance={data.performance} />
          </div>
        </div>
      )}
    </PageTransition>
  );
}
