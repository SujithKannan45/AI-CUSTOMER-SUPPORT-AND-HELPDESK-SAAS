import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TicketTrendChart } from './ticket-trend-chart';
import type { TrendPointDto } from '../types';

const created: TrendPointDto[] = [
  { bucket: '2026-09-01T00:00:00.000Z', count: 2 },
  { bucket: '2026-09-02T00:00:00.000Z', count: 3 },
];

const resolved: TrendPointDto[] = [
  { bucket: '2026-09-01T00:00:00.000Z', count: 1 },
  { bucket: '2026-09-02T00:00:00.000Z', count: 0 },
];

describe('TicketTrendChart', () => {
  it('renders the real series, totals and accessible name', () => {
    render(<TicketTrendChart created={created} resolved={resolved} bucket="day" />);

    expect(screen.getByText('Ticket trend')).toBeInTheDocument();
    expect(screen.getByText('Created')).toBeInTheDocument();
    expect(screen.getByText('Resolved')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /Ticket trend: 5 created and 1 resolved/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Totals in this period: 5 created · 1 resolved/)).toBeInTheDocument();
  });

  it('shows a genuine empty state for zero-filled periods', () => {
    render(
      <TicketTrendChart
        created={[{ bucket: '2026-09-01T00:00:00.000Z', count: 0 }]}
        resolved={[{ bucket: '2026-09-01T00:00:00.000Z', count: 0 }]}
        bucket="day"
      />,
    );

    expect(screen.getByText('No ticket activity in this period')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('exposes bucket values to keyboard users', () => {
    render(<TicketTrendChart created={created} resolved={resolved} bucket="day" />);

    const chart = screen.getByRole('img');
    fireEvent.keyDown(chart, { key: 'ArrowRight' });

    expect(screen.getByText(/Sep 1: 2 created, 1 resolved/)).toBeInTheDocument();
  });
});
