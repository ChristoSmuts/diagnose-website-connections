import type { ClientEvidence, Evidence, ServerEvidence, VantageHealth } from '@dwc/contracts';
import { ms } from './findings/helpers.js';
import { instabilityRatio, lossRatio } from './stats.js';
import {
  controlIsLoopback,
  MIN_SAMPLES_FOR_VARIANCE,
  PATH_DEGRADATION,
  THRESHOLDS,
  classify,
  classifyInverted,
  type Band,
  type Band3,
} from './thresholds.js';

/** Worst wins — used to fold several independent signals into one status. */
function worst(...values: readonly (Band3 | 'unknown')[]): Band3 | 'unknown' {
  if (values.includes('bad')) return 'bad';
  if (values.includes('degraded')) return 'degraded';
  if (values.includes('ok')) return 'ok';
  return 'unknown';
}

/**
 * Penalty that scales with how far past a threshold a value actually sits.
 *
 * A flat per-band penalty would score a 700ms response and a 5000ms one
 * identically, because both are merely "bad". That produced scores like 75/100
 * alongside a critical finding, which reads as reassuring when it should not.
 * Within the degraded band the penalty ramps linearly; past it, it climbs
 * towards the full amount as the value approaches double the threshold.
 */
function graded(value: number | null, band: Band, degradedMax: number, badMax: number): number {
  if (value === null || Number.isNaN(value)) return 0;
  if (value <= band.ok) return 0;

  if (value <= band.degraded) {
    const span = band.degraded - band.ok;
    const t = span > 0 ? (value - band.ok) / span : 1;
    return degradedMax * t;
  }

  // Saturates at roughly four times the "degraded" threshold. Wide enough that
  // 1.8s and 6s genuinely differ, bounded so the score cannot run away.
  const excess = band.degraded > 0 ? (value - band.degraded) / (band.degraded * 3) : 1;
  return degradedMax + (badMax - degradedMax) * Math.min(1, excess);
}

/** Same idea for metrics where a higher number is better (throughput). */
function gradedInverted(
  value: number | null,
  band: Band,
  degradedMax: number,
  badMax: number,
): number {
  if (value === null || Number.isNaN(value)) return 0;
  if (value >= band.ok) return 0;

  if (value >= band.degraded) {
    const span = band.ok - band.degraded;
    const t = span > 0 ? (band.ok - value) / span : 1;
    return degradedMax * t;
  }

  const shortfall = band.degraded > 0 ? (band.degraded - value) / band.degraded : 1;
  return degradedMax + (badMax - degradedMax) * Math.min(1, shortfall);
}

const clampScore = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Vantage S — the target's health as seen from a neutral, well-connected place.
 *
 * Because our server is not on the user's link, anything slow here is slow for
 * everyone. That is what makes this vantage able to convict the site itself.
 */
export function assessServer(server: ServerEvidence): VantageHealth {
  if (server.fatalError !== null) {
    return {
      status: 'bad',
      label: 'Their server',
      summary: 'We could not connect to this site at all.',
      score: 0,
    };
  }

  const reachable = server.addresses.some((a) => a.reachable);
  if (server.addresses.length > 0 && !reachable) {
    return {
      status: 'bad',
      label: 'Their server',
      summary: 'The site has an address but refused every connection.',
      score: 0,
    };
  }

  const ttfb = classify(server.http?.ttfbMs.value ?? null, THRESHOLDS.ttfbMs);
  const tcpValue = server.addresses.find((a) => a.reachable)?.tcpConnectMs.value ?? null;

  const ratio = server.stability ? instabilityRatio(server.stability.ttfb) : null;

  /**
   * Variance only counts once there are enough samples to mean anything.
   *
   * An interquartile range computed from three requests is mostly noise — a
   * single slow response makes a perfectly healthy site look erratic. Below the
   * threshold it can still be raised as a low-confidence finding, but it must
   * not drive the headline verdict.
   */
  const sampleCount = server.stability?.ttfb.count ?? 0;
  const stability =
    sampleCount >= MIN_SAMPLES_FOR_VARIANCE
      ? classify(ratio, THRESHOLDS.instabilityRatio)
      : ('unknown' as const);

  const score = clampScore(
    100 -
      graded(server.http?.ttfbMs.value ?? null, THRESHOLDS.ttfbMs, 25, 60) -
      graded(server.dns.lookupMs.value, THRESHOLDS.dnsMs, 8, 18) -
      graded(tcpValue, THRESHOLDS.tcpMs, 8, 18) -
      graded(server.tls?.handshakeMs.value ?? null, THRESHOLDS.tlsMs, 5, 12) -
      graded(ratio, THRESHOLDS.instabilityRatio, 10, 25),
  );

  // TTFB and stability decide the status; DNS/TCP/TLS only shade the score.
  // A site with slow DNS but a fast backend is not a "slow server", and saying
  // so would send the owner chasing the wrong thing.
  const status = worst(ttfb, stability);

  return {
    status: status === 'unknown' ? 'unknown' : status,
    label: 'Their server',
    summary: describeServer(status, server),
    score,
  };
}

function describeServer(status: Band3 | 'unknown', server: ServerEvidence): string {
  const ttfb = server.http?.ttfbMs.value;
  if (status === 'ok') {
    return ttfb === null || ttfb === undefined
      ? 'Responding normally.'
      : `Responding quickly (${ms(ttfb)} to start sending the page).`;
  }
  if (status === 'unknown') return 'We could not measure this site’s response time.';

  // A site can be degraded because it is slow OR because it is erratic, and
  // those need different words. Reporting "slow to respond (63ms)" when the real
  // problem is inconsistency is simply wrong, and invites the reader to dismiss
  // the whole report.
  const slow = classify(ttfb ?? null, THRESHOLDS.ttfbMs);
  if (slow === 'ok') {
    const stats = server.stability?.ttfb;
    return stats === undefined
      ? 'Responding inconsistently.'
      : `Usually quick (${ms(stats.median ?? 0)}) but inconsistent — some requests took ${ms(stats.max ?? 0)}.`;
  }

  return status === 'bad'
    ? `Very slow to respond (${ms(ttfb ?? 0)} before the first byte).`
    : `Slower than it should be (${ms(ttfb ?? 0)} before it starts sending anything).`;
}

/**
 * Vantage K — the user's own internet connection.
 *
 * Measured against *our* endpoint, deliberately: it is the only way to tell a
 * bad link apart from a bad site. Returns `unknown` when the browser did not
 * report, and the engine treats that as a hard block on blaming the user.
 */
export function assessUserConnection(client: ClientEvidence | null): VantageHealth {
  if (client === null) {
    return {
      status: 'unknown',
      label: 'Your connection',
      summary: 'Not measured — run the test from a browser to include this.',
      score: null,
    };
  }

  /**
   * A loopback control measures the machine, not the connection.
   *
   * When this tool is self-hosted on the same device as the browser — the default
   * for local use — the control endpoint answers in 1–5ms over loopback. Reporting
   * that as "your connection is healthy" would be actively misleading: a user on a
   * failing link would be told their connection is perfect. We have not measured
   * their internet at all, so we say so.
   */
  if (controlIsLoopback(client)) {
    return {
      status: 'unknown',
      label: 'Your connection',
      summary:
        'Not measured — this tool is running on your own machine, so there is no network between you and it to test. Set CONTROL_URL to measure against an instance across the internet.',
      score: null,
    };
  }

  const rtt = classify(client.control.median, THRESHOLDS.clientRttMs);
  const jitter = classify(client.control.jitter, THRESHOLDS.clientJitterMs);
  const loss = classify(lossRatio(client.control), THRESHOLDS.clientLossRatio);
  const throughput = client.throughput?.consented
    ? classifyInverted(client.throughput.downloadBps.value, THRESHOLDS.throughputBps)
    : 'unknown';

  const lossValue = lossRatio(client.control);
  const throughputValue = client.throughput?.consented ? client.throughput.downloadBps.value : null;

  const score = clampScore(
    100 -
      graded(client.control.median, THRESHOLDS.clientRttMs, 18, 40) -
      graded(client.control.jitter, THRESHOLDS.clientJitterMs, 10, 22) -
      graded(lossValue, THRESHOLDS.clientLossRatio, 20, 45) -
      gradedInverted(throughputValue, THRESHOLDS.throughputBps, 10, 22),
  );

  const status = worst(rtt, jitter, loss, throughput);

  return {
    status,
    label: 'Your connection',
    summary: describeClient(status, client),
    score,
  };
}

/**
 * Names the endpoint a round trip was measured against, when it was not us.
 *
 * "42 ms round trip" is a different claim depending on what answered, and the
 * number alone cannot carry that. A reader comparing two reports deserves to
 * know one was measured against a different machine.
 */
function against(client: ClientEvidence): string {
  return client.controlOrigin === null ? '' : ` to ${hostOf(client.controlOrigin)}`;
}

/**
 * The host part of an origin, without reaching for the URL global.
 *
 * This package is pure by rule — no I/O, no clock, no randomness — and leaning on
 * an ambient platform global weakens that for the sake of trimming a scheme. The
 * input is a validated origin from the API config, so there is no parsing to do
 * beyond dropping the scheme and anything after the authority.
 */
function hostOf(origin: string): string {
  const withoutScheme = origin.replace(/^[a-z][\w+.-]*:\/\//i, '');
  const end = withoutScheme.search(/[/?#]/);
  return end === -1 ? withoutScheme : withoutScheme.slice(0, end);
}

function describeClient(status: Band3 | 'unknown', client: ClientEvidence): string {
  const rtt = client.control.median;
  const to = against(client);
  switch (status) {
    case 'ok':
      return rtt === null ? 'Behaving normally.' : `Healthy (${ms(rtt)} round trip${to}, steady).`;
    case 'degraded':
      return `A little slow or unsteady (${ms(rtt ?? 0)} round trip${to}).`;
    case 'bad':
      return `Slow or unreliable (${ms(rtt ?? 0)} round trip${to}).`;
    default:
      return 'Not measured.';
  }
}

/**
 * Vantage "between" — the path from this user to this site.
 *
 * There is no direct instrument for this, so it is derived: given how long the
 * user's own link takes and how long the server takes to respond, we know
 * roughly what their combined experience *should* be. A large unexplained
 * excess is the path itself — routing, peering, or a distant CDN edge.
 *
 * Always reported as inferred, never measured.
 */
export function assessNetworkPath(evidence: Evidence): VantageHealth & { excessMs: number | null } {
  const { server, client } = evidence;

  if (client === null) {
    return {
      status: 'unknown',
      label: 'The path between',
      summary: 'Not measured — needs a browser-side test.',
      score: null,
      excessMs: null,
    };
  }

  const actual = client.target.median;
  const userLatency = client.control.median;
  const serverTime = server.http?.ttfbMs.value ?? null;

  if (actual === null || userLatency === null || serverTime === null) {
    return {
      status: 'unknown',
      label: 'The path between',
      summary: 'Not enough data to judge the route.',
      score: null,
      excessMs: null,
    };
  }

  // A loopback control gives us no idea what the user's internet actually costs,
  // so there is nothing to subtract and no honest way to attribute the remainder.
  if (controlIsLoopback(client)) {
    return {
      status: 'unknown',
      label: 'The path between',
      summary:
        'Cannot be judged — this tool is running on your own machine, so there is no separate connection to compare against. Set CONTROL_URL to measure against an instance across the internet.',
      score: null,
      excessMs: null,
    };
  }

  /*
   * An unpaired control endpoint measures the reader's link honestly and cannot
   * be subtracted from their time to the target.
   *
   * The arithmetic below treats the baseline and the target measurement as
   * comparable. They are not when the baseline came from an arbitrary endpoint:
   * a large provider answers from whichever edge is nearest the reader, so the
   * baseline is short by however far the target actually is, and the remainder
   * this attributes to their provider is really the distance to the site.
   */
  if (!client.controlIsPaired) {
    return {
      status: 'unknown',
      label: 'The path between',
      summary:
        'Cannot be judged — the baseline was measured against an endpoint that is not another instance of this tool, so there is nothing comparable to subtract. Point CONTROL_URL at a second instance to measure the route as well.',
      score: null,
      excessMs: null,
    };
  }

  /**
   * What the browser's request *should* cost.
   *
   * The browser pays for name lookup, connection and encryption on top of the
   * server's own thinking time, whereas the server-side TTFB is measured on a
   * connection that is already open. Comparing the two directly overstates the
   * excess by the whole setup cost and manufactures a routing problem out of
   * ordinary connection overhead.
   */
  const setupCost =
    (server.dns.lookupMs.value ?? 0) +
    (server.addresses.find((a) => a.reachable)?.tcpConnectMs.value ?? 0) +
    (server.tls?.handshakeMs.value ?? 0);

  const expected = userLatency + serverTime + setupCost;
  const excess = actual - expected;
  const overBy = expected > 0 ? actual / expected : 1;

  const degraded = overBy >= PATH_DEGRADATION.ratio && excess >= PATH_DEGRADATION.absoluteFloorMs;
  const bad =
    overBy >= PATH_DEGRADATION.ratio * 1.75 && excess >= PATH_DEGRADATION.absoluteFloorMs * 2;

  const status: Band3 = bad ? 'bad' : degraded ? 'degraded' : 'ok';
  const score = clampScore(bad ? 35 : degraded ? 65 : 95);

  return {
    status,
    label: 'The path between',
    summary:
      status === 'ok'
        ? 'Traffic is taking a sensible route.'
        : `Roughly ${ms(excess)} is being lost between you and the site, beyond what either end explains.`,
    score,
    excessMs: excess,
  };
}
