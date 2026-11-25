import { describe, expect, it } from 'vitest';
import {
  bucketForFilter,
  customBounds,
  formatBucketLabel,
  formatPeriodLabel,
  isValidDateInput,
  selectionLabel,
  selectionToFilter,
  validateCustomRange,
} from './date-range';

describe('dashboard date ranges', () => {
  it('maps presets directly to the backend range values', () => {
    expect(selectionToFilter({ kind: 'preset', preset: '7d' })).toEqual({ range: '7d' });
    expect(selectionToFilter({ kind: 'preset', preset: '90d' })).toEqual({ range: '90d' });
  });

  it('turns inclusive calendar days into UTC half-open bounds', () => {
    expect(customBounds('2026-01-01', '2026-01-07')).toEqual({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-08T00:00:00.000Z',
    });
    expect(selectionToFilter({ kind: 'custom', from: '2026-02-01', to: '2026-02-01' })).toEqual({
      range: 'custom',
      from: '2026-02-01T00:00:00.000Z',
      to: '2026-02-02T00:00:00.000Z',
    });
  });

  it('rejects missing, malformed, inverted and oversized custom ranges', () => {
    expect(validateCustomRange('', '2026-01-01')).toBe('Choose both a start and an end date.');
    expect(validateCustomRange('2026-02-30', '2026-03-01')).toBe('Enter valid calendar dates.');
    expect(validateCustomRange('2026-03-02', '2026-03-01')).toBe(
      'The start date must be on or before the end date.',
    );
    expect(validateCustomRange('2025-01-01', '2026-12-31')).toBe('Choose a range of 366 days or fewer.');
    expect(validateCustomRange('2026-01-01', '2026-12-31')).toBeNull();
  });

  it('accepts only real yyyy-mm-dd dates', () => {
    expect(isValidDateInput('2026-02-28')).toBe(true);
    expect(isValidDateInput('2026-02-30')).toBe(false);
    expect(isValidDateInput('26-02-28')).toBe(false);
  });

  it('coarsens buckets only for long custom windows', () => {
    expect(bucketForFilter({ range: '90d' })).toBe('day');
    expect(
      bucketForFilter({
        range: 'custom',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-02-20T00:00:00.000Z',
      }),
    ).toBe('week');
    expect(
      bucketForFilter({
        range: 'custom',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-07-30T00:00:00.000Z',
      }),
    ).toBe('month');
  });

  it('labels selections and the server-resolved period', () => {
    expect(selectionLabel({ kind: 'preset', preset: '30d' })).toBe('Last 30 days');
    expect(selectionLabel({ kind: 'custom', from: '2026-01-01', to: '2026-01-07' })).toBe(
      'Custom range',
    );
    expect(
      formatPeriodLabel({ from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' }),
    ).toBe('Sep 1, 2026 – Sep 30, 2026');
    expect(formatBucketLabel('2026-09-05T00:00:00.000Z', 'day')).toBe('Sep 5');
    expect(formatBucketLabel('2026-09-01T00:00:00.000Z', 'month')).toBe('Sep 26');
  });
});
