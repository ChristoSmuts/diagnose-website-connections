import type { ClientEvidence, SampleStats } from '@dwc/contracts';
import { computeStats } from '@dwc/diagnostics';

/**
 * Browser-side measurement — vantages K and T.
 *
 * This is the half of the diagnosis the server cannot perform. Without it the
 * engine can never legitimately say "the problem is your connection", and it
 * enforces that rather than guessing.
 *
 * Everything here is measured against our OWN endpoint first. That control is
 * what separates a slow link from a slow site: if our endpoint is slow for you
 * too, the target is not the problem.
 */

export interface ClientProbeOptions {
  /** The site being diagnosed, for the coarse target measurement. */
  targetUrl: string;
  /** Users must opt in — a throughput test spends their data. */
  throughputConsent: boolean;
  /** Progress callback for the UI. */
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

const LATENCY_SAMPLES = 12;
const LATENCY_TIMEOUT_MS = 4000;
/** Hard cap on the throughput test. Deliberately modest: it is not a speed test. */
const THROUGHPUT_BYTES = 4_000_000;
const THROUGHPUT_TIMEOUT_MS = 10_000;

export async function runClientProbe(options: ClientProbeOptions): Promise<ClientEvidence> {
  const { onProgress = () => {}, signal } = options;

  onProgress('Measuring your connection…');
  const control = await measureLatency('/api/ping', LATENCY_SAMPLES, signal);

  onProgress('Measuring the route to this site…');
  const target = await measureTarget(options.targetUrl, signal);

  let throughput: ClientEvidence['throughput'] = null;
  if (options.throughputConsent) {
    onProgress('Measuring your speed…');
    throughput = await measureThroughput(signal);
  }

  return {
    observedAt: new Date().toISOString(),
    control,
    target,
    throughput,
    connectionHint: readConnectionHint(),
  };
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
