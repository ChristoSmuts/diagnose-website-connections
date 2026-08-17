/**
 * Every number the engine judges against, in one place.
 *
 * These are deliberately centralised and named rather than scattered as magic
 * numbers, because they are the engine's opinions — the part most likely to be
 * argued with, tuned, or need justifying to a sceptical site owner.
 *
 * Server-side thresholds assume a well-connected vantage. That assumption is
 * what makes them meaningful: if a server is slow to *us*, it is slow.
 */

export interface Band {
  /** At or below this is healthy. */
  readonly ok: number;
  /** Above this is bad; between the two is degraded. */
  readonly degraded: number;
}

export const THRESHOLDS = {
  /** DNS lookup. Anything past ~150ms is a real, felt delay before anything starts. */
  dnsMs: { ok: 50, degraded: 150 } satisfies Band,

  /** TCP connect. Largely distance and routing; ~100ms is roughly intercontinental. */
  tcpMs: { ok: 100, degraded: 300 } satisfies Band,

  /** TLS handshake, on top of TCP. */
  tlsMs: { ok: 150, degraded: 400 } satisfies Band,

  /**
   * Time to first byte, server-side. This is the single strongest signal that a
   * problem is the site's own backend rather than the network.
   */
  ttfbMs: { ok: 200, degraded: 600 } satisfies Band,

  /** Browser → our control endpoint. Characterises the user's own link. */
  clientRttMs: { ok: 60, degraded: 200 } satisfies Band,

  /** Variation between consecutive samples — what makes calls and video stutter. */
  clientJitterMs: { ok: 20, degraded: 60 } satisfies Band,

  /** Proportion of probes that failed outright, as a packet-loss proxy. */
  clientLossRatio: { ok: 0.01, degraded: 0.05 } satisfies Band,

  /** Download throughput in bytes/sec. ~5 MB/s ≈ 40 Mbps. */
  throughputBps: { ok: 5_000_000, degraded: 1_500_000 } satisfies Band,

  /**
   * Instability, as IQR ÷ median. Scale-free on purpose: 50ms of spread means
   * something very different on a 40ms response than on a 4000ms one.
   */
  instabilityRatio: { ok: 0.25, degraded: 0.6 } satisfies Band,

  /** Redirect hops before the real page. Each one is a full round trip. */
  redirects: { ok: 1, degraded: 3 } satisfies Band,

  /** Transferred page weight in bytes. */
  payloadBytes: { ok: 2_000_000, degraded: 5_000_000 } satisfies Band,

  /** DNS TTL in seconds; very low values force constant re-lookups. */
  minTtlSeconds: 60,

  /** CNAME hops before an address is reached. */
  cnameChainLength: 3,

  /** TLS chain depth; every extra cert is more bytes in the handshake. */
  tlsChainLength: 4,
} as const;

/** Certificate expiry, in days remaining. */
export const CERT_EXPIRY = {
  critical: 7,
  warning: 30,
} as const;

/**
 * How much slower than expected the user's path to the target must be before we
 * blame the path itself.
 *
 * Expected ≈ the user's own latency + the server's own response time. Exceeding
 * both a ratio *and* an absolute floor avoids crying foul over a few tens of
 * milliseconds on an already-fast connection.
 */
export const PATH_DEGRADATION = {
  ratio: 2.0,
  absoluteFloorMs: 250,
} as const;

/**
 * Below this round-trip time, the control endpoint is on the same machine or LAN
 * as the browser.
 *
 * This matters because the default deployment of this tool is self-hosted and
 * often local. When the API is on localhost, the "your connection" measurement
 * describes a loopback interface rather than an internet connection: it comes
 * back at 1–5ms and looks flawless no matter how bad the real link is.
 *
 * Every genuine internet round trip then appears to be unexplained excess, and
 * the engine would confidently blame the user's ISP for latency it never
 * measured. Since a real internet path cannot realistically beat this, treating
 * it as "no usable baseline" is the honest reading.
 */
export const LOCAL_CONTROL_RTT_MS = 8;

/**
 * Samples required before response-time variance may influence the verdict.
 *
 * An IQR from three requests is dominated by noise: one unlucky response makes a
 * healthy site look erratic, which produced the contradictory verdict "slow to
 * respond (63ms)" with a health score of 96. Below this, variance is reported as
 * a low-confidence finding rather than treated as a fact about the site.
 */
export const MIN_SAMPLES_FOR_VARIANCE = 5;

/** TLS versions we consider outdated regardless of anything else. */
export const OUTDATED_TLS_PROTOCOLS: readonly string[] = ['SSLv3', 'TLSv1', 'TLSv1.1'] as const;

export type Band3 = 'ok' | 'degraded' | 'bad';

/** Classify a value against a band. Null (not measured) is never "ok". */
export function classify(value: number | null, band: Band): Band3 | 'unknown' {
  if (value === null || Number.isNaN(value)) return 'unknown';
  if (value <= band.ok) return 'ok';
  if (value <= band.degraded) return 'degraded';
  return 'bad';
}

/** As `classify`, but for metrics where a *higher* number is better. */
export function classifyInverted(value: number | null, band: Band): Band3 | 'unknown' {
  if (value === null || Number.isNaN(value)) return 'unknown';
  if (value >= band.ok) return 'ok';
  if (value >= band.degraded) return 'degraded';
  return 'bad';
}
