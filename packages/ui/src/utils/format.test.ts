import { describe, expect, it } from 'vitest';
import { formatBytes, formatWhen } from './format.js';

/**
 * The switch from relative to absolute time matters for the history sidebar:
 * "3 min ago" is what you want when comparing a re-run against the previous
 * result, and a date is what you want a fortnight later.
 */
describe('formatWhen', () => {
  const now = new Date('2026-08-17T12:00:00.000Z');

  it('says "just now" within the last minute', () => {
    expect(formatWhen('2026-08-17T11:59:30.000Z', now)).toBe('just now');
  });

  it('counts minutes, then hours, then days', () => {
    expect(formatWhen('2026-08-17T11:45:00.000Z', now)).toBe('15 min ago');
    expect(formatWhen('2026-08-17T08:00:00.000Z', now)).toBe('4 hr ago');
    expect(formatWhen('2026-08-14T12:00:00.000Z', now)).toBe('3 days ago');
  });

  it('falls back to a date once relative time stops being useful', () => {
    const result = formatWhen('2026-06-01T12:00:00.000Z', now);
    expect(result).not.toMatch(/ago/);
    expect(result).toMatch(/2026/);
  });

  it('returns the raw value rather than "NaN days ago" for an unparseable date', () => {
    expect(formatWhen('not-a-date', now)).toBe('not-a-date');
  });
});

describe('formatBytes', () => {
  it('keeps small payloads legible instead of rounding them to zero', () => {
    // A 318-byte response once displayed as "0 KB", which read as "empty".
    expect(formatBytes(318)).toBe('318 B');
  });

  it('scales to KB and MB', () => {
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00 MB');
  });
});
