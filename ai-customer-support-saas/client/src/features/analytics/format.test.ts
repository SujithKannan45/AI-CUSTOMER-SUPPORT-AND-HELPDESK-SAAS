import { describe, expect, it } from 'vitest';
import { formatCount, formatDuration } from './format';

describe('analytics formatting', () => {
  it('formats counts with grouping', () => {
    expect(formatCount(1234)).toBe('1,234');
    expect(formatCount(0)).toBe('0');
  });

  it('keeps a missing duration distinct from zero', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(0)).toBe('< 1 min');
  });

  it('formats minutes, hours and days', () => {
    expect(formatDuration(45 * 60_000)).toBe('45m');
    expect(formatDuration(5_400_000)).toBe('1h 30m');
    expect(formatDuration(2 * 3_600_000)).toBe('2h');
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d 4h');
    expect(formatDuration(2 * 86_400_000)).toBe('2d');
  });
});
