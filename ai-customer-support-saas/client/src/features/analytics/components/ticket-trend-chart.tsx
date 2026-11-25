import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import { LineChart } from 'lucide-react';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatBucketLabel } from '@/features/analytics/date-range';
import { formatCount } from '@/features/analytics/format';
import type { AnalyticsBucketUnit, TrendPointDto } from '@/features/analytics/types';

const CHART_HEIGHT = 248;
const MARGIN = { top: 16, right: 16, bottom: 28, left: 40 } as const;
const FALLBACK_WIDTH = 640;

interface TrendPoint {
  readonly bucket: string;
  readonly created: number;
  readonly resolved: number;
}

function niceMax(value: number): number {
  if (value <= 4) return 4;
  return Math.ceil(value / 4) * 4;
}

function useChartWidth(): { ref: RefObject<HTMLDivElement | null>; width: number } {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);

  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width;
      if (measured !== undefined && measured > 0) setWidth(measured);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  return { ref, width };
}

export interface TicketTrendChartProps {
  readonly created: readonly TrendPointDto[];
  readonly resolved: readonly TrendPointDto[];
  readonly bucket: AnalyticsBucketUnit;
}

/**
 * Created vs resolved tickets per server bucket.
 *
 * The series are the backend's zero-filled points — this component never
 * interpolates or invents a period. Values are shown on hover, on focus with
 * arrow keys, and in an aria-live summary for assistive technology.
 */
export function TicketTrendChart({ created, resolved, bucket }: TicketTrendChartProps): JSX.Element {
  const { ref, width } = useChartWidth();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const resolvedByBucket = new Map(resolved.map((point) => [point.bucket, point.count]));
  const points: TrendPoint[] = created.map((point) => ({
    bucket: point.bucket,
    created: point.count,
    resolved: resolvedByBucket.get(point.bucket) ?? 0,
  }));

  useEffect(() => {
    setActiveIndex(null);
  }, [created, resolved]);

  const plotWidth = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;
  const maxValue = points.reduce((max, point) => Math.max(max, point.created, point.resolved), 0);
  const yMax = niceMax(maxValue);
  const createdTotal = points.reduce((sum, point) => sum + point.created, 0);
  const resolvedTotal = points.reduce((sum, point) => sum + point.resolved, 0);

  const xFor = (index: number): number =>
    points.length <= 1 ? MARGIN.left + plotWidth / 2 : MARGIN.left + (index / (points.length - 1)) * plotWidth;
  const yFor = (value: number): number => MARGIN.top + plotHeight - (value / yMax) * plotHeight;

  const linePath = (values: readonly number[]): string =>
    values.map((value, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index).toFixed(1)} ${yFor(value).toFixed(1)}`).join(' ');

  const createdValues = points.map((point) => point.created);
  const resolvedValues = points.map((point) => point.resolved);
  const createdPath = linePath(createdValues);
  const resolvedPath = linePath(resolvedValues);
  const areaPath =
    points.length === 0
      ? ''
      : `${createdPath} L ${xFor(points.length - 1).toFixed(1)} ${(MARGIN.top + plotHeight).toFixed(1)} L ${xFor(0).toFixed(1)} ${(MARGIN.top + plotHeight).toFixed(1)} Z`;

  const activePoint = activeIndex !== null ? points[activeIndex] : undefined;

  const tickStride = Math.max(1, Math.ceil(points.length / 6));
  const xTickIndices = points
    .map((_, index) => index)
    .filter((index) => index % tickStride === 0 || index === points.length - 1);

  function handlePointerMove(event: PointerEvent<SVGSVGElement>): void {
    if (points.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const chartX = ((event.clientX - rect.left) / rect.width) * width;
    const ratio = (chartX - MARGIN.left) / plotWidth;
    const index = Math.round(ratio * Math.max(1, points.length - 1));
    setActiveIndex(Math.min(points.length - 1, Math.max(0, index)));
  }

  function handleKeyDown(event: KeyboardEvent<SVGSVGElement>): void {
    if (points.length === 0) return;
    const supported = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!supported.includes(event.key)) return;

    event.preventDefault();
    setActiveIndex((current) => {
      if (event.key === 'Home') return 0;
      if (event.key === 'End') return points.length - 1;
      if (current === null) return event.key === 'ArrowLeft' ? points.length - 1 : 0;
      const delta = event.key === 'ArrowLeft' ? -1 : 1;
      return Math.min(points.length - 1, Math.max(0, current + delta));
    });
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Ticket trend</CardTitle>
          <CardDescription>
            Created and resolved tickets per {bucket} bucket · zero-filled by the analytics API
          </CardDescription>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted">
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="h-2 w-2 rounded-full bg-primary" />
            Created
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="h-2 w-2 rounded-full bg-success" />
            Resolved
          </span>
        </div>
      </CardHeader>

      <CardBody>
        {points.length === 0 || maxValue === 0 ? (
          <div className="flex h-56 flex-col items-center justify-center gap-2 text-center">
            <LineChart aria-hidden className="h-7 w-7 text-muted" />
            <p className="text-sm font-medium text-foreground">No ticket activity in this period</p>
            <p className="max-w-sm text-xs leading-5 text-muted">
              No tickets were created or resolved inside the selected window. Adjust the date range to look further back.
            </p>
          </div>
        ) : (
          <>
            <div ref={ref} className="relative w-full">
              <svg
                width={width}
                height={CHART_HEIGHT}
                viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
                className="block w-full touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                role="img"
                tabIndex={0}
                aria-label={`Ticket trend: ${formatCount(createdTotal)} created and ${formatCount(resolvedTotal)} resolved in the selected period. Use the left and right arrow keys to inspect each ${bucket}.`}
                onPointerMove={handlePointerMove}
                onPointerLeave={() => {
                  setActiveIndex(null);
                }}
                onKeyDown={handleKeyDown}
                onBlur={() => {
                  setActiveIndex(null);
                }}
              >
                {[0, 1, 2, 3, 4].map((step) => {
                  const value = (yMax / 4) * step;
                  const y = yFor(value);
                  return (
                    <g key={step}>
                      <line
                        x1={MARGIN.left}
                        x2={width - MARGIN.right}
                        y1={y}
                        y2={y}
                        stroke="var(--color-border)"
                        strokeWidth={1}
                        strokeDasharray={step === 0 ? undefined : '3 4'}
                      />
                      <text
                        x={MARGIN.left - 8}
                        y={y + 3}
                        textAnchor="end"
                        fontSize={10}
                        fill="var(--color-muted)"
                      >
                        {formatCount(Math.round(value))}
                      </text>
                    </g>
                  );
                })}

                <path d={areaPath} fill="var(--color-primary)" opacity={0.08} />
                <path
                  d={createdPath}
                  fill="none"
                  stroke="var(--color-primary)"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                <path
                  d={resolvedPath}
                  fill="none"
                  stroke="var(--color-success)"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />

                {xTickIndices.map((index) => {
                  const point = points[index];
                  if (point === undefined) return null;
                  return (
                    <text
                      key={point.bucket}
                      x={xFor(index)}
                      y={CHART_HEIGHT - 8}
                      textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
                      fontSize={10}
                      fill="var(--color-muted)"
                    >
                      {formatBucketLabel(point.bucket, bucket)}
                    </text>
                  );
                })}

                {activePoint !== undefined && activeIndex !== null ? (
                  <g>
                    <line
                      x1={xFor(activeIndex)}
                      x2={xFor(activeIndex)}
                      y1={MARGIN.top}
                      y2={MARGIN.top + plotHeight}
                      stroke="var(--color-border-strong)"
                      strokeWidth={1}
                    />
                    <circle
                      cx={xFor(activeIndex)}
                      cy={yFor(activePoint.created)}
                      r={3.5}
                      fill="var(--color-primary)"
                    />
                    <circle
                      cx={xFor(activeIndex)}
                      cy={yFor(activePoint.resolved)}
                      r={3.5}
                      fill="var(--color-success)"
                    />
                  </g>
                ) : null}
              </svg>

              {activePoint !== undefined && activeIndex !== null ? (
                <div
                  aria-hidden
                  className="pointer-events-none absolute z-sticky min-w-36 rounded-lg border border-border bg-surface px-2.5 py-2 text-xs shadow-popover"
                  style={{
                    left: Math.min(Math.max(xFor(activeIndex), 80), Math.max(80, width - 80)),
                    top: yFor(Math.max(activePoint.created, activePoint.resolved)),
                    transform: 'translate(-50%, calc(-100% - 10px))',
                  }}
                >
                  <p className="font-medium text-foreground">{formatBucketLabel(activePoint.bucket, bucket)}</p>
                  <p className="mt-1 flex items-center justify-between gap-3 text-muted">
                    <span>Created</span>
                    <span className="font-medium tabular-nums text-foreground">{formatCount(activePoint.created)}</span>
                  </p>
                  <p className="flex items-center justify-between gap-3 text-muted">
                    <span>Resolved</span>
                    <span className="font-medium tabular-nums text-foreground">{formatCount(activePoint.resolved)}</span>
                  </p>
                </div>
              ) : null}
            </div>

            <p className="sr-only" aria-live="polite">
              {activePoint !== undefined
                ? `${formatBucketLabel(activePoint.bucket, bucket)}: ${formatCount(activePoint.created)} created, ${formatCount(activePoint.resolved)} resolved.`
                : ''}
            </p>
            <p className="mt-2 text-[11px] text-muted">
              Totals in this period: {formatCount(createdTotal)} created · {formatCount(resolvedTotal)} resolved.
            </p>
          </>
        )}
      </CardBody>
    </Card>
  );
}
