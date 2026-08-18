import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import type { HttpEvidence, RedirectHop, StabilityEvidence } from '@dwc/contracts';
import { measured, unavailable } from '@dwc/contracts';
import { computeStats } from '@dwc/diagnostics';
import { resolveSafely } from '../safety/ssrf.ts';
import { errorMessage, stopwatch } from './timing.ts';

export interface HttpProbeOptions {
  url: string;
  maxRedirects: number;
  maxBytes: number;
  timeoutMs: number;
  resolvers: readonly string[];
}

/**
 * Force a connection to one specific, already-validated address.
 *
 * This is the mechanism that closes DNS rebinding. Validating a hostname and
 * then letting the HTTP client resolve it again leaves a window in which an
 * attacker-controlled nameserver can answer with a public address for the check
 * and 127.0.0.1 for the request. By supplying the resolved address directly, the
 * bytes go where we actually looked.
 *
 * It also means we never depend on the host's system resolver, which during
 * development was a local proxy that refused queries outright.
 */
function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    // Node calls this with either (hostname, options, cb) or (hostname, cb).
    const done = typeof options === 'function' ? options : callback;
    if (typeof done !== 'function') return;

    if (typeof options === 'object' && options !== null && options.all === true) {
      (done as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
        { address, family },
      ]);
      return;
    }
    (done as (e: null, a: string, f: number) => void)(null, address, family);
  };
}

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  httpVersion: string;
  ttfbMs: number;
  message: IncomingMessage;
}

/** One request to one pinned address, resolving as soon as headers arrive. */
function requestOnce(
  url: URL,
  address: string,
  family: 4 | 6,
  timeoutMs: number,
  overrides: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const elapsed = stopwatch();
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;

    const req = send(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        lookup: pinnedLookup(address, family),
        // Diagnosing, not trusting — certificate problems are findings to
        // report, not reasons to refuse to look.
        rejectUnauthorized: false,
        servername: url.hostname.replace(/^\[|\]$/g, ''),
        headers: {
          host: url.host,
          'accept-encoding': 'br, gzip, deflate',
          accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          'user-agent': 'dwc-diagnostics/1.0 (+website connection diagnostics)',
          connection: 'close',
          ...overrides,
        },
      },
      (message) => {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(message.headers)) {
          headers[key] = Array.isArray(value) ? value.join(', ') : (value ?? '');
        }
        resolve({
          status: message.statusCode ?? 0,
          headers,
          // Real negotiated version, which fetch() does not expose at all.
          httpVersion: message.httpVersion,
          ttfbMs: elapsed(),
          message,
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.once('error', reject);
    req.end();
  });
}

/**
 * Fetch the page, following redirects by hand.
 *
 * Manual redirect handling because we need per-hop timing — redirect chains are
 * a cost nobody sees but every visitor pays — and because every hop must be
 * re-resolved and re-validated. A public URL redirecting to an internal address
 * would otherwise walk straight past the checks done on the original.
 */
export async function probeHttp(options: HttpProbeOptions): Promise<HttpEvidence> {
  const { maxRedirects, maxBytes, timeoutMs, resolvers } = options;
  const redirects: RedirectHop[] = [];

  let current = new URL(options.url);
  let response: RawResponse | undefined;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // Re-validated on every hop, not just the first.
    const safe = await resolveSafely(current.hostname.replace(/^\[|\]$/g, ''), resolvers);
    const first = safe.addresses[0];
    if (first === undefined) {
      throw new Error(`${current.hostname} does not resolve to a reachable address.`);
    }

    const result = await requestOnce(current, first.address, first.family, timeoutMs);

    if (isRedirect(result.status)) {
      const location = result.headers.location ?? null;
      redirects.push({
        url: current.toString(),
        status: result.status,
        location,
        durationMs: measured(result.ttfbMs, 'ms'),
      });

      result.message.resume(); // release the socket
      if (location === null) {
        response = result;
        break;
      }
      current = new URL(location, current);
      continue;
    }

    response = result;
    break;
  }

  if (response === undefined) {
    throw new Error(`More than ${maxRedirects} redirects — the chain never settles.`);
  }

  const downloadStart = stopwatch();
  const { bytes, truncated } = await readCapped(response.message, maxBytes);
  const downloadMs = downloadStart();

  const encoding = response.headers['content-encoding'] ?? null;
  const altSvc = response.headers['alt-svc'] ?? null;
  const declared = Number(response.headers['content-length']);

  return {
    status: response.status,
    httpVersion: response.httpVersion,
    http3Advertised: altSvc !== null && /h3/.test(altSvc),
    ttfbMs: measured(response.ttfbMs, 'ms'),
    downloadMs: measured(downloadMs, 'ms'),
    totalMs: measured(response.ttfbMs + downloadMs, 'ms'),
    redirects,
    contentEncoding: encoding,
    compressionRatio: unavailable(
      'ratio',
      'servers do not report the pre-compression size, so the exact saving cannot be measured',
    ),
    transferredBytes: truncated
      ? unavailable('bytes', `the response exceeded the ${String(maxBytes)}-byte safety cap`)
      : measured(bytes, 'bytes'),
    uncompressedBytes: Number.isFinite(declared)
      ? measured(declared, 'bytes')
      : unavailable('bytes', 'the server did not declare a content length'),
    cacheControl: response.headers['cache-control'] ?? null,
    serverTiming: response.headers['server-timing'] ?? null,
    hsts: 'strict-transport-security' in response.headers,
    contentSecurityPolicy: 'content-security-policy' in response.headers,
    timingAllowOrigin: 'timing-allow-origin' in response.headers,
    headers: response.headers,
  };
}

const isRedirect = (status: number): boolean =>
  status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

/**
 * Read the body, never exceeding `maxBytes`.
 *
 * An unbounded read against a hostile — or merely enormous — URL is a trivial
 * way to exhaust the server's memory.
 */
function readCapped(
  message: IncomingMessage,
  maxBytes: number,
): Promise<{ bytes: number; truncated: boolean }> {
  return new Promise((resolve) => {
    let total = 0;
    let settled = false;

    const finish = (truncated: boolean): void => {
      if (settled) return;
      settled = true;
      message.destroy();
      resolve({ bytes: total, truncated });
    };

    message.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) finish(true);
    });
    message.once('end', () => finish(false));
    // A truncated read still yields a usable byte count.
    message.once('error', () => finish(true));
  });
}

/**
 * Repeat the request to see whether the server is consistent.
 *
 * Sequential rather than parallel, deliberately: concurrent requests would
 * measure the site's concurrency limits rather than its response time, and
 * hammering someone else's server is not acceptable behaviour for a diagnostic.
 *
 * The first sample is kept apart as "cold" — the gap between it and the rest is
 * what reveals whether caching or a CDN is doing any real work.
 */
export async function probeStability(
  url: string,
  address: string,
  family: 4 | 6,
  samples: number,
  timeoutMs: number,
): Promise<StabilityEvidence> {
  const timings: number[] = [];
  let failed = 0;
  const target = new URL(url);

  for (let i = 0; i < samples; i += 1) {
    try {
      const result = await requestOnce(target, address, family, timeoutMs);
      timings.push(result.ttfbMs);
      result.message.resume();
      result.message.destroy();
    } catch {
      failed += 1;
    }
  }

  const cold = timings[0];
  const warm = timings.slice(1).sort((a, b) => a - b);
  const warmMedian = warm.length > 0 ? warm[Math.floor(warm.length / 2)] : undefined;

  return {
    ttfb: computeStats(timings, failed, 'ms'),
    coldTtfbMs:
      cold === undefined ? unavailable('ms', 'no sample succeeded') : measured(cold, 'ms'),
    warmTtfbMs:
      warmMedian === undefined
        ? unavailable('ms', 'only one sample succeeded, so there is nothing to compare against')
        : measured(warmMedian, 'ms'),
  };
}

/**
 * One SSRF-guarded GET, returning the body rather than just measuring it.
 *
 * `probeHttp` counts bytes and throws the content away, because the diagnosis
 * only cares how big the page is. Fetching a favicon needs the bytes themselves,
 * and it must go through the same address validation and IP pinning — a site's
 * icon URL is attacker-controlled input exactly like the site's URL is.
 *
 * Deliberately small: no redirect following beyond one hop, a hard byte cap, and
 * null for anything that is not a plainly successful image response.
 */
export async function fetchSmallAsset(options: {
  url: string;
  maxBytes: number;
  timeoutMs: number;
  resolvers: readonly string[];
}): Promise<{ contentType: string; body: Buffer } | null> {
  const { maxBytes, timeoutMs, resolvers } = options;

  let current: URL;
  try {
    current = new URL(options.url);
  } catch {
    return null;
  }

  /*
   * A short redirect chain is normal for a favicon and worth following.
   *
   * Wikipedia takes two hops before it serves one — wikipedia.org to
   * www.wikipedia.org to en.wikipedia.org — so a single-hop limit found nothing
   * for one of the most obvious sites anyone would test. Still bounded, and every
   * hop is resolved and validated afresh.
   */
  for (let hop = 0; hop < 4; hop += 1) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') return null;

    const safe = await resolveSafely(current.hostname.replace(/^\[|\]$/g, ''), resolvers);
    const first = safe.addresses[0];
    if (first === undefined) return null;

    /*
     * Identity encoding, unlike the page probe.
     *
     * The page probe asks for compression because whether a server offers it is
     * part of the diagnosis. Here the bytes are the point, and asking for gzip
     * meant the compressed stream went straight into a data URL — GitHub's icon
     * was stored as base64 of a gzip member, which no browser will render.
     */
    const result = await requestOnce(current, first.address, first.family, timeoutMs, {
      'accept-encoding': 'identity',
      accept: 'image/*,*/*;q=0.8',
    });

    if (isRedirect(result.status)) {
      const location = result.headers.location ?? null;
      result.message.resume();
      if (location === null) return null;
      try {
        current = new URL(location, current);
      } catch {
        return null;
      }
      continue;
    }

    if (result.status !== 200) {
      result.message.resume();
      return null;
    }

    // A server may compress regardless of what was asked. Better to have no icon
    // than a data URL of a gzip member.
    const encoding = (result.headers['content-encoding'] ?? 'identity').toLowerCase();
    if (encoding !== 'identity' && encoding !== '') {
      result.message.resume();
      return null;
    }

    const body = await collectCapped(result.message, maxBytes);
    if (body === null) return null;

    return { contentType: (result.headers['content-type'] ?? '').split(';')[0]!.trim(), body };
  }

  return null;
}

/** Reads a whole small body, or gives up entirely once it exceeds the cap. */
function collectCapped(message: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (value: Buffer | null): void => {
      if (settled) return;
      settled = true;
      message.destroy();
      resolve(value);
    };

    message.on('data', (chunk: Buffer) => {
      total += chunk.length;
      // A truncated image is worse than none: it would render as a broken glyph.
      if (total > maxBytes) return finish(null);
      chunks.push(chunk);
    });
    message.once('end', () => finish(Buffer.concat(chunks)));
    message.once('error', () => finish(null));
  });
}

export { errorMessage };
