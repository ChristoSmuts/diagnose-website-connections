import type { ClientEvidence, SampleStats } from '@dwc/contracts';
import { computeStats } from '@dwc/diagnostics';

/**
 * Browser-side measurement — vantages K and T.
 *
 * This is the half of the diagnosis the server cannot perform. Without it the
 * engine can never legitimately say "the problem is your connection", and it
 * enforces that rather than guessing.
 *
 * Everything here is measured against a control endpoint first. That control is
 * what separates a slow link from a slow site: if the control is slow for you
 * too, the target is not the problem.
 */

export interface ClientProbeOptions {
  /** The site being diagnosed, for the coarse target measurement. */
  targetUrl: string;
  /**
   * Origin to measure the baseline against. Null means this one.
   *
   * Same-origin is right for a hosted instance and useless for a local one: the
   * round trip is then loopback at 1-5ms, which describes no internet connection
   * at all. Pointing this at another instance reachable across the internet is
   * what lets a self-hosted install judge the user's link and the path. See
   * CONTROL_URL in the API config.
   */
  controlUrl?: string | null;
  /**
   * Public endpoints to time alongside the target, establishing the reader's
   * floor. Empty unless the operator opted in — these are third parties.
   */
  referenceUrls?: readonly string[];
  /** Users must opt in — a throughput test spends their data. */
  throughputConsent: boolean;
  /** Progress callback for the UI. */
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

const LATENCY_SAMPLES = 12;
/**
 * Fewer than the control gets. A reference only has to establish a floor, and
 * every sample is a request to somebody else's server on the reader's behalf.
 */
const REFERENCE_SAMPLES = 5;
const LATENCY_TIMEOUT_MS = 4000;
/** Hard cap on the throughput test. Deliberately modest: it is not a speed test. */
const THROUGHPUT_BYTES = 4_000_000;
const THROUGHPUT_TIMEOUT_MS = 10_000;

export async function runClientProbe(options: ClientProbeOptions): Promise<ClientEvidence> {
  const { onProgress = () => {}, signal } = options;

  const controlOrigin = options.controlUrl ?? null;

  onProgress('Measuring your connection…');

  /*
   * Ask the control endpoint what it is before measuring against it.
   *
   * Two facts come back from one request. Whether it is another instance of this
   * app — only an instance answers a readable /api/health — which decides
   * whether the round trip can be measured properly or only timed opaquely. And
   * whether the reader's connection to it ended at a CDN edge, which the browser
   * cannot possibly work out for itself: from out here a CDN-fronted instance
   * and a directly-reachable one are indistinguishable.
   */
  const identity = await probeControl(controlOrigin, signal);
  const control = identity.paired
    ? await measureLatency(`${controlOrigin ?? ''}/api/ping`, LATENCY_SAMPLES, signal)
    : await measureOpaqueLatency(controlOrigin ?? '', LATENCY_SAMPLES, signal);

  onProgress('Measuring the route to this site…');
  const target = await measureTarget(options.targetUrl, signal);

  /*
   * Reference endpoints, timed the same opaque way as the target.
   *
   * Sequential rather than concurrent, and for the same reason the latency
   * samples are: running them together would measure the browser's connection
   * limit rather than the network. Anything unreachable simply contributes no
   * samples, which the engine reads as "no floor established" rather than as a
   * slow one.
   */
  const references: ClientEvidence['references'] = [];
  for (const origin of options.referenceUrls ?? []) {
    if (signal?.aborted === true) break;
    const stats = await measureOpaqueLatency(origin, REFERENCE_SAMPLES, signal);
    if (stats.median !== null) references.push({ origin, stats });
  }

  let throughput: ClientEvidence['throughput'] = null;
  if (options.throughputConsent) {
    onProgress('Measuring your speed…');
    throughput = await measureThroughput(signal);
  }

  return {
    observedAt: new Date().toISOString(),
    control,
    /*
     * Whether the endpoint we just measured is on this machine or this LAN.
     *
     * Reported as a fact rather than left to be inferred from the timing. The
     * engine used to decide this purely from how fast the answer came back, which
     * works until it does not: WebKit's loopback round trip measured 15 ms here,
     * cleared the threshold, and the report called a loopback interface a healthy
     * internet connection. The browser knows the address; it should say so.
     */
    controlIsLocal: isLocalHost(controlOrigin),
    /*
     * Recorded structurally rather than left to the prose.
     *
     * "Your connection responded in 42 ms" is a different claim depending on what
     * answered, and a reader cannot tell the two apart from the number. Carrying
     * the origin means the report can say which, and cannot forget to.
     */
    controlOrigin,
    /*
     * Whether that endpoint is another instance of this app.
     *
     * The path verdict subtracts this measurement from the browser's time to the
     * target, so the two have to be comparable. An arbitrary endpoint is not: a
     * large anycast provider answers from the nearest edge by design, which makes
     * the baseline too small, the expected time too low, and the leftover — which
     * the report blames on the reader's provider — inflated by nothing worse than
     * distance. So an unpaired control still characterises the reader's own link,
     * and the path stays unmeasured.
     */
    controlIsPaired: identity.paired,
    /*
     * Whether that endpoint answered from an edge rather than from itself.
     *
     * Reported by the endpoint, not inferred here. It leaves "your connection"
     * alone — an edge round trip still describes the last mile honestly — and
     * stops the route verdict subtracting a baseline that is too short.
     */
    controlIsEdgeTerminated: identity.edgeTerminated,
    /*
     * The throughput test always fetches from this page's own origin, so it
     * measures loopback on a local install even when CONTROL_URL is remote.
     * Recorded separately for that reason.
     */
    appIsLocal: isLocalHost(null),
    references,
    target,
    throughput,
    connectionHint: readConnectionHint(),
  };
}

/**
 * Whether an origin names this machine or this local network.
 *
 * Null means same-origin, so the page's own hostname is the one to judge — which
 * is the common case and the one that matters: the default deployment is
 * self-hosted on localhost.
 *
 * Deliberately generous about what counts as local. A false positive costs a
 * vantage that reads "not measured", which is merely unhelpful. A false negative
 * blames somebody's internet provider for latency that never left the machine.
 */
function isLocalHost(origin: string | null): boolean {
  let host: string;
  try {
    host = (origin === null ? window.location : new URL(origin)).hostname.toLowerCase();
  } catch {
    return false;
  }

  // IPv6 literals arrive bracketed from location.hostname in some browsers.
  const bare = host.replace(/^\[|\]$/g, '');

  if (bare === 'localhost' || bare.endsWith('.localhost')) return true;
  // mDNS names resolve on the local network only.
  if (bare.endsWith('.local')) return true;
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true;
  if (bare === '0.0.0.0') return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    // Link-local, including the cloud metadata address.
    if (a === 169 && b === 254) return true;
  }

  // Unique local addresses: fc00::/7.
  if (/^f[cd][0-9a-f]{2}:/.test(bare)) return true;
  // IPv6 link-local: fe80::/10.
  if (/^fe[89ab][0-9a-f]:/.test(bare)) return true;

  return false;
}

/**
 * Round-trip time to our own endpoint, sampled repeatedly.
 *
 * Sequential rather than parallel: concurrent requests would share bandwidth and
 * queue against each other, measuring the browser's connection limit instead of
 * the network's latency. Cache-busted so a proxy cannot answer instantly and
 * make a bad link look perfect.
 */
async function measureLatency(
  path: string,
  samples: number,
  signal?: AbortSignal,
): Promise<SampleStats> {
  const timings: number[] = [];
  let failed = 0;

  for (let i = 0; i < samples; i += 1) {
    if (signal?.aborted === true) break;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LATENCY_TIMEOUT_MS);
    const started = performance.now();

    try {
      const response = await fetch(`${path}?n=${String(i)}&t=${String(Date.now())}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      await response.arrayBuffer();
      timings.push(performance.now() - started);
    } catch {
      // Counted as loss: a request that never came back is exactly what packet
      // loss looks like from up here.
      failed += 1;
    } finally {
      clearTimeout(timer);
    }
  }

  // The first sample includes connection setup, so it is discarded when we have
  // enough others — otherwise it inflates the median on every single run.
  const usable = timings.length > 3 ? timings.slice(1) : timings;
  return computeStats(usable, failed, 'ms');
}

/**
 * How long the target takes to answer, from the user's browser.
 *
 * Necessarily coarse. CORS redacts cross-origin timing detail unless the site
 * sets Timing-Allow-Origin, and `no-cors` gives an opaque response we can time
 * but not inspect. That limitation is real and is why the engine treats the
 * derived path figure as inferred rather than measured.
 */
async function measureTarget(url: string, signal?: AbortSignal): Promise<SampleStats> {
  const timings: number[] = [];
  let failed = 0;

  for (let i = 0; i < 5; i += 1) {
    if (signal?.aborted === true) break;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LATENCY_TIMEOUT_MS * 2);
    const started = performance.now();

    try {
      await fetch(`${url}${url.includes('?') ? '&' : '?'}dwc=${String(Date.now())}`, {
        mode: 'no-cors',
        cache: 'no-store',
        signal: controller.signal,
      });
      timings.push(performance.now() - started);
    } catch {
      failed += 1;
    } finally {
      clearTimeout(timer);
    }
  }

  const usable = timings.length > 2 ? timings.slice(1) : timings;
  return computeStats(usable, failed, 'ms');
}

/**
 * Rough download and upload throughput.
 *
 * A short in-browser transfer understates a genuinely fast link, because TCP
 * spends much of a small transfer still ramping up. The engine therefore treats
 * this as a floor rather than a precise figure, and the finding says so.
 */
async function measureThroughput(signal?: AbortSignal): Promise<ClientEvidence['throughput']> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), THROUGHPUT_TIMEOUT_MS);

  try {
    const downStart = performance.now();
    const response = await fetch(`/api/download?bytes=${String(THROUGHPUT_BYTES)}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    const payload = await response.arrayBuffer();
    const downSeconds = (performance.now() - downStart) / 1000;
    const downloadBps = downSeconds > 0 ? payload.byteLength / downSeconds : 0;

    const upBytes = Math.min(THROUGHPUT_BYTES / 4, 1_000_000);
    const upStart = performance.now();
    await fetch('/api/upload', {
      method: 'POST',
      body: new Uint8Array(upBytes),
      cache: 'no-store',
      signal: controller.signal,
    });
    const upSeconds = (performance.now() - upStart) / 1000;
    const uploadBps = upSeconds > 0 ? upBytes / upSeconds : 0;

    return {
      downloadBps: { value: downloadBps, unit: 'bytes-per-second', provenance: 'measured' },
      uploadBps: { value: uploadBps, unit: 'bytes-per-second', provenance: 'measured' },
      consented: true,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    void signal;
  }
}

/**
 * The browser's own opinion of the connection.
 *
 * Corroboration only, never primary evidence: it is absent in Safari and
 * Firefox, and where present it is a coarse bucket rather than a measurement.
 */
function readConnectionHint(): ClientEvidence['connectionHint'] {
  const nav = navigator as Navigator & {
    connection?: {
      effectiveType?: string;
      downlink?: number;
      rtt?: number;
      saveData?: boolean;
    };
  };

  const connection = nav.connection;
  if (connection === undefined) return null;

  return {
    effectiveType: connection.effectiveType ?? null,
    downlinkMbps: connection.downlink ?? null,
    rttMs: connection.rtt ?? null,
    saveData: connection.saveData ?? null,
  };
}

/**
 * What the control endpoint is, asked rather than assumed.
 *
 * `/api/health` is the only endpoint that answers both questions at once, and it
 * is unauthenticated and rate-limit exempt precisely so a paired instance can be
 * asked by a browser that holds no session with it.
 *
 * A CORS rejection, a 404 or an unreachable host all land in the same place and
 * all mean the same thing: not an instance of this app. Same-origin is an
 * instance by definition, but still has to be asked about the edge.
 */
async function probeControl(
  origin: string | null,
  signal?: AbortSignal,
): Promise<{ paired: boolean; edgeTerminated: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LATENCY_TIMEOUT_MS);
  const abort = (): void => controller.abort();
  signal?.addEventListener('abort', abort);
  try {
    const response = await fetch(`${origin ?? ''}/api/health?probe=control`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return { paired: origin === null, edgeTerminated: false };
    const body = (await response.json()) as { edgeTerminated?: unknown };
    return { paired: true, edgeTerminated: body.edgeTerminated === true };
  } catch {
    // Same-origin is still an instance even if this one call failed; anything
    // else is not, and gets the opaque measurement instead.
    return { paired: origin === null, edgeTerminated: false };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * Round trip to an endpoint we are not allowed to read.
 *
 * `no-cors` gives an opaque response — the timing is real, the contents are not
 * available. That is the whole trick behind allowing an arbitrary control URL:
 * the far end needs to grant nothing and does not need to know this tool exists.
 *
 * It measures slightly more than the readable version, since the promise settles
 * on the whole response rather than after reading a known-tiny body. The first
 * sample is discarded either way, which is where connection setup lands.
 */
async function measureOpaqueLatency(
  url: string,
  samples: number,
  signal?: AbortSignal,
): Promise<SampleStats> {
  const timings: number[] = [];
  let failed = 0;

  for (let i = 0; i < samples; i += 1) {
    if (signal?.aborted === true) break;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LATENCY_TIMEOUT_MS);
    const started = performance.now();

    try {
      await fetch(`${url}${url.includes('?') ? '&' : '?'}dwc=${String(i)}-${String(Date.now())}`, {
        mode: 'no-cors',
        cache: 'no-store',
        signal: controller.signal,
      });
      timings.push(performance.now() - started);
    } catch {
      failed += 1;
    } finally {
      clearTimeout(timer);
    }
  }

  const usable = timings.length > 3 ? timings.slice(1) : timings;
  return computeStats(usable, failed, 'ms');
}
