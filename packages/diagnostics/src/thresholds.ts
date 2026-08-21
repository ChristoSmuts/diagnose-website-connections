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

  /**
   * Browser → a paired instance's `/api/ping`. Characterises the user's own link.
   *
   * Calibrated for that endpoint specifically: a readable, near-empty JSON body
   * from a server doing as close to no work as possible.
   */
  clientRttMs: { ok: 60, degraded: 200 } satisfies Band,

  /**
   * Browser → any other endpoint, timed opaquely.
   *
   * A `no-cors` fetch settles on the whole response rather than after reading a
   * known-empty body, so it reads systematically higher than the ping band — but
   * only by a little, and the difference was measured rather than guessed. On a
   * 100 Mb line in Cape Town, fetching the identical URL both ways:
   *
   *     cloudflare.com/cdn-cgi/trace      readable 15 ms   opaque 24 ms
   *     speed.cloudflare.com/__down       readable 49 ms   opaque 55 ms
   *
   * So roughly 6-9 ms of overhead. This band is the readable one plus about twice
   * that, which keeps a link sitting near the boundary from flipping to "degraded"
   * on the instrument alone, and costs nothing in sensitivity: a genuinely bad
   * connection is several hundred milliseconds, not seventy.
   *
   * Resist widening it further. The bug that motivated splitting these bands was
   * not the instrument at all — it was `CONTROL_URL` losing its path, so the
   * browser timed the Google home page instead of an empty 204 and reported 957 ms
   * as the reader's latency. A band wide enough to absorb *that* would have
   * silenced every real complaint too.
   */
  clientRttOpaqueMs: { ok: 75, degraded: 220 } satisfies Band,

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
/**
 * Browser → target round trip above which distance becomes the explanation of
 * last resort.
 *
 * Only ever applied together with two other facts: nothing is in front of the
 * origin, and the route itself is not adding unexplained time. With a CDN ruled
 * out and routing ruled out, what is left on a round trip this long is the
 * length of the wire — 150 ms is comfortably intercontinental, and the existing
 * `tcpMs` band already calls 100 ms "roughly intercontinental" from a
 * well-connected server.
 *
 * A high round trip on its own proves nothing about distance: queueing, a busy
 * server or a bad route all add time too. That is exactly why this is never the
 * sole condition.
 */
export const DISTANT_ORIGIN_RTT_MS = 150;

export const LOCAL_CONTROL_RTT_MS = 8;

/**
 * Whether the control measurement describes a local interface rather than a link.
 *
 * Two independent signals, and either is enough:
 *
 * 1. What the browser reported about the address it measured. This is a fact.
 * 2. A round trip faster than any real internet path. This is an inference.
 *
 * The inference alone was not sufficient. It held for years on Chromium, where a
 * loopback round trip is 1-3 ms, and failed on WebKit, where the same loopback
 * measured 15 ms and was duly reported as a healthy internet connection. The fact
 * is now primary and the inference is the backstop — it still catches a control
 * endpoint reached through a local proxy or a container network, which the
 * hostname check cannot see.
 */
export function controlIsLoopback(client: {
  controlIsLocal?: boolean;
  control: { median: number | null };
}): boolean {
  if (client.controlIsLocal === true) return true;
  return client.control.median !== null && client.control.median < LOCAL_CONTROL_RTT_MS;
}

/**
 * Whether the control measurement may be subtracted from the reader's time to
 * the target.
 *
 * Three deployments break that subtraction, and they are one fault wearing three
 * hats: **the baseline is nearer than the target, so the remainder is distance
 * rather than routing.**
 *
 * 1. Loopback — the control is on the reader's own machine. Distance zero.
 * 2. Unpaired — `CONTROL_URL` points at some public endpoint rather than another
 *    instance. Large providers answer from the edge nearest the reader, so again
 *    the baseline is as short as the internet gets.
 * 3. Edge-terminated — the control *is* another instance, but it sits behind a
 *    CDN or a tunnel, so the reader's connection ended at a nearby point of
 *    presence and never reached the machine.
 *
 * In all three the leftover the route verdict would attribute to the reader's
 * provider is really the distance to the site. Blaming an ISP for geography is
 * the same error as blaming one for loopback, and this project has now shipped
 * that error twice.
 *
 * Note what this does *not* gate: "your connection". An edge-terminated or
 * unpaired baseline still describes the reader's own link honestly — better than
 * a distant origin would, since it is closer to a pure last-mile measurement.
 * Only the subtraction is invalid.
 */
export function controlCanAnchorPath(client: {
  controlIsLocal?: boolean;
  controlIsPaired?: boolean;
  controlIsEdgeTerminated?: boolean;
  control: { median: number | null };
}): boolean {
  if (controlIsLoopback(client)) return false;
  if (client.controlIsPaired === false) return false;
  if (client.controlIsEdgeTerminated === true) return false;
  return true;
}

/**
 * Which band the browser's control round trip should be judged against.
 *
 * Paired and unpaired controls are measured by different instruments — a readable
 * `/api/ping` against an opaque `no-cors` fetch — and the flag that separates them
 * already travels on the evidence. Reading it in one place stops the vantage, the
 * finding and the check drifting apart, which is exactly how the report ends up
 * contradicting itself.
 */
export function clientRttBand(client: { controlIsPaired?: boolean }): Band {
  return client.controlIsPaired === false ? THRESHOLDS.clientRttOpaqueMs : THRESHOLDS.clientRttMs;
}

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
