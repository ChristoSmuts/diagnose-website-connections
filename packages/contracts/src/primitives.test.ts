import { describe, expect, it } from 'vitest';
import { MetricSchema, inferred, measured, unavailable } from './primitives.js';

/**
 * These tests guard the honesty invariant, not the type system.
 *
 * The whole report's credibility rests on never presenting a guess as an
 * observation, so the schema — not a code-review habit — has to enforce it.
 */
describe('Metric provenance invariant', () => {
  it('accepts a measured value with no basis', () => {
    expect(MetricSchema.safeParse(measured(24.1, 'ms')).success).toBe(true);
  });

  it('rejects an inferred value that does not state its basis', () => {
    const result = MetricSchema.safeParse({
      value: 120,
      unit: 'ms',
      provenance: 'inferred',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/must state a basis/i);
  });

  it('accepts an inferred value once a basis is given', () => {
    expect(
      MetricSchema.safeParse(inferred(120, 'ms', 'derived from total minus TTFB')).success,
    ).toBe(true);
  });

  it('rejects an unavailable metric that smuggles in a placeholder number', () => {
    // A zero here would render as "0ms" — indistinguishable from "instant".
    const result = MetricSchema.safeParse({
      value: 0,
      unit: 'ms',
      provenance: 'unavailable',
      basis: 'CORS hid the timing',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/null value/i);
  });

  it('accepts a properly-null unavailable metric', () => {
    expect(MetricSchema.safeParse(unavailable('ms', 'CORS hid the timing')).success).toBe(true);
  });
});
