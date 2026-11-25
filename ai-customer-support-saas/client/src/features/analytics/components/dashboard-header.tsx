import { useState, type JSX } from 'react';
import { CalendarDays, RotateCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/common/page-header';
import { ROLE_LABELS, type WorkspaceRole } from '@/features/workspace/types';
import {
  DASHBOARD_PRESETS,
  daysAgoUtc,
  formatPeriodLabel,
  selectionLabel,
  todayUtc,
  validateCustomRange,
  type DashboardPreset,
  type DashboardSelection,
} from '@/features/analytics/date-range';
import type { AnalyticsPeriodDto } from '@/features/analytics/types';
import { cn } from '@/utils/cn.util';

const PRESET_BUTTON =
  'rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export interface DashboardHeaderProps {
  readonly workspaceName: string;
  readonly role: WorkspaceRole | null;
  readonly selection: DashboardSelection;
  readonly onSelectionChange: (selection: DashboardSelection) => void;
  readonly onRefresh: () => void;
  readonly isRefreshing: boolean;
  readonly period: AnalyticsPeriodDto | null;
  readonly lastUpdated: string | null;
}

function updatedLabel(iso: string | null): string | null {
  if (iso === null) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(date);
}

/**
 * Dashboard heading: page identity, current workspace, date window and the
 * refresh action. Presets map 1:1 to the backend `range` values; the custom
 * panel validates locally and only then asks for a new window.
 */
export function DashboardHeader({
  workspaceName,
  role,
  selection,
  onSelectionChange,
  onRefresh,
  isRefreshing,
  period,
  lastUpdated,
}: DashboardHeaderProps): JSX.Element {
  const [customOpen, setCustomOpen] = useState(selection.kind === 'custom');
  const [from, setFrom] = useState(selection.kind === 'custom' ? selection.from : daysAgoUtc(29));
  const [to, setTo] = useState(selection.kind === 'custom' ? selection.to : todayUtc());
  const [customError, setCustomError] = useState<string | null>(null);

  const updated = updatedLabel(lastUpdated);

  function choosePreset(preset: DashboardPreset): void {
    setCustomOpen(false);
    setCustomError(null);
    onSelectionChange({ kind: 'preset', preset });
  }

  function applyCustom(): void {
    const error = validateCustomRange(from, to);
    if (error !== null) {
      setCustomError(error);
      return;
    }
    setCustomError(null);
    setCustomOpen(false);
    onSelectionChange({ kind: 'custom', from, to });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={[{ label: 'Workspace' }, { label: 'Overview' }]}
        title="Overview"
        description="Ticket workload, resolution performance and customer activity for the current workspace. Every number comes from the workspace analytics API."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            isLoading={isRefreshing}
            leftIcon={<RotateCw aria-hidden className="h-3.5 w-3.5" />}
          >
            {isRefreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />

      <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-foreground">{workspaceName}</span>
            {role !== null ? <Badge tone="brand">{ROLE_LABELS[role]}</Badge> : null}
          </div>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <CalendarDays aria-hidden className="h-3.5 w-3.5" />
            <span>{selectionLabel(selection)}</span>
            {period !== null ? (
              <>
                <span aria-hidden>·</span>
                <span>{formatPeriodLabel(period)}</span>
                <span aria-hidden>·</span>
                <span>UTC</span>
                <span aria-hidden>·</span>
                <span>{period.bucket} buckets</span>
              </>
            ) : null}
            {updated !== null ? (
              <>
                <span aria-hidden>·</span>
                <span>Updated {updated} UTC</span>
              </>
            ) : null}
          </p>
          <p className="sr-only" aria-live="polite">
            {isRefreshing ? 'Refreshing analytics data.' : ''}
          </p>
        </div>

        <div className="flex flex-col items-start gap-2 sm:items-end">
          <div className="flex flex-wrap items-center gap-1 rounded-lg border border-border p-1" role="group" aria-label="Date range">
            {DASHBOARD_PRESETS.map((item) => {
              const active = selection.kind === 'preset' && selection.preset === item.id && !customOpen;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    choosePreset(item.id);
                  }}
                  className={cn(
                    PRESET_BUTTON,
                    active
                      ? 'bg-primary-soft text-primary'
                      : 'text-muted hover:bg-surface-hover hover:text-foreground',
                  )}
                >
                  {item.label}
                </button>
              );
            })}
            <button
              type="button"
              aria-pressed={customOpen || selection.kind === 'custom'}
              aria-expanded={customOpen}
              aria-controls="dashboard-custom-range"
              onClick={() => {
                setCustomOpen((open) => !open);
                setCustomError(null);
              }}
              className={cn(
                PRESET_BUTTON,
                customOpen || selection.kind === 'custom'
                  ? 'bg-primary-soft text-primary'
                  : 'text-muted hover:bg-surface-hover hover:text-foreground',
              )}
            >
              Custom
            </button>
          </div>

          {customOpen ? (
            <div
              id="dashboard-custom-range"
              className="w-full space-y-2 rounded-lg border border-border bg-surface-subtle p-3 sm:w-auto"
            >
              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1">
                  <label htmlFor="dashboard-from" className="block text-[11px] font-medium text-muted">
                    From
                  </label>
                  <Input
                    id="dashboard-from"
                    type="date"
                    value={from}
                    max={to}
                    onChange={(event) => {
                      setFrom(event.target.value);
                      setCustomError(null);
                    }}
                    className="w-36"
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="dashboard-to" className="block text-[11px] font-medium text-muted">
                    To
                  </label>
                  <Input
                    id="dashboard-to"
                    type="date"
                    value={to}
                    min={from}
                    max={todayUtc()}
                    onChange={(event) => {
                      setTo(event.target.value);
                      setCustomError(null);
                    }}
                    className="w-36"
                  />
                </div>
                <Button size="sm" onClick={applyCustom}>
                  Apply
                </Button>
              </div>
              {customError !== null ? (
                <p role="alert" className="text-xs text-danger">
                  {customError}
                </p>
              ) : (
                <p className="text-[11px] text-muted">Inclusive calendar days, computed in UTC. Maximum 366 days.</p>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
