import type { SampleStats, Unit } from '@dwc/contracts';

/**
 * Turn raw samples into the summary the engine reasons about.
 *
 * Median and IQR rather than mean and standard deviation throughout: network
 * latency is heavily right-skewed, so a single retransmit or GC pause drags a
 * mean somewhere that describes no real request. The median describes the
 * typical experience; the IQR describes how much it varies.
 */
export function computeStats(samples: readonly number[], failed: number, unit: Unit): SampleStats {
  const clean = samples.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);

  if (clean.length === 0) {
    return {
      count: samples.length,
      failed,
      min: null,
      median: null,
      p95: null,
      max: null,
      iqr: null,
      jitter: null,
      unit,
    };
  }

  return {
    count: samples.length,
    failed,
    min: clean[0] ?? null,
    median: quantile(clean, 0.5),
    p95: quantile(clean, 0.95),
    max: clean[clean.length - 1] ?? null,
    iqr: (quantile(clean, 0.75) ?? 0) - (quantile(clean, 0.25) ?? 0),
    // Jitter is computed on the ORIGINAL order, not the sorted copy: it measures
    // change between consecutive requests, which sorting would destroy.
    jitter: meanConsecutiveDelta(samples.filter((n) => Number.isFinite(n))),
    unit,
  };
}

/** Linear-interpolated quantile over an already-sorted array. */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0] ?? null;

  const pos = (sorted.length - 1) * q;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  const low = sorted[lower];
  const high = sorted[upper];
  if (low === undefined || high === undefined) return null;
  if (lower === upper) return low;
  return low + (high - low) * (pos - lower);
}

/**
 * Mean absolute difference between consecutive samples.
 *
 * This is jitter as a user actually experiences it — the request-to-request
 * inconsistency that makes a connection feel unreliable even when its average
 * looks fine.
 */
export function meanConsecutiveDelta(samples: readonly number[]): number | null {
  if (samples.length < 2) return null;
  let total = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const current = samples[i];
    const previous = samples[i - 1];
    if (current === undefined || previous === undefined) continue;
    total += Math.abs(current - previous);
  }
  return total / (samples.length - 1);
}

/**
 * Spread relative to typical value — the scale-free instability signal.
 *
 * Returns null rather than Infinity when the median is zero or missing, so
 * callers cannot accidentally treat "no data" as "infinitely unstable".
 */
export function instabilityRatio(stats: SampleStats): number | null {
  if (stats.median === null || stats.iqr === null || stats.median <= 0) return null;
  return stats.iqr / stats.median;
}

/** Proportion of attempts that failed outright. Our proxy for packet loss. */
export function lossRatio(stats: SampleStats): number | null {
  const attempts = stats.count + stats.failed;
  if (attempts === 0) return null;
  return stats.failed / attempts;
}
