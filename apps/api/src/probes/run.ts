import type { DiagnosticEvent, ProbePhase, ServerEvidence } from '@dwc/contracts';
import { ms, plural } from '@dwc/diagnostics';
import type { Config } from '../config.ts';
import { normalizeUrl, resolveSafely } from '../safety/ssrf.ts';
import { EMPTY_NETWORK, probeAsn } from './asn.ts';
import { probeTcp, probeTls } from './connect.ts';
import { probeDns } from './dns.ts';
import { probeHttp, probeStability } from './http.ts';
import { probePtr } from './ptr.ts';
import { errorMessage } from './timing.ts';

export type PhaseReporter = (
  phase: ProbePhase,
  status: 'started' | 'complete' | 'skipped' | 'failed',
  message: string,
) => void;

/**
 * Run the full server-side probe suite.
 *
 * Ordering is dictated by dependency, not preference: DNS gives addresses, an
 * address is needed to connect, a connection is needed for TLS, and TLS tells us
 * the negotiated protocol. Only ASN lookup and stability sampling are genuinely
 * independent, and those run concurrently with each other at the end.
 *
 * Nothing here throws for a *diagnostic* failure. An unreachable site is a
 * result, not an error — the engine needs the partial evidence to say so.
 */
export async function runServerProbe(
  inputUrl: string,
  config: Config,
  report: PhaseReporter = () => {},
): Promise<ServerEvidence> {
  report('validating', 'started', 'Checking the address…');
  const target = normalizeUrl(inputUrl);
  report('validating', 'complete', `Checking ${target.host}`);

  const base: ServerEvidence = {
    target: {
      inputUrl,
      normalizedUrl: target.normalizedUrl,
      host: target.host,
      port: target.port,
      scheme: target.scheme,
    },
    observedAt: new Date().toISOString(),
    vantage: 'primary',
    dns: {
      records: [],
      resolvers: [],
      consistent: true,
      authoritative: [],
      cnameChainLength: 0,
      minTtlSeconds: null,
      dnssec: null,
      lookupMs: { value: null, unit: 'ms', provenance: 'unavailable', basis: 'not attempted' },
    },
    addresses: [],
    tls: null,
    http: null,
    stability: null,
    network: EMPTY_NETWORK,
    fatalError: null,
  };

  // --- DNS -----------------------------------------------------------------
  report('dns', 'started', 'Looking up the address…');
  let resolved: Awaited<ReturnType<typeof resolveSafely>>;
  try {
    const [dns, safe] = await Promise.all([
      probeDns(target.host, config.resolvers, config.timeouts.dnsMs),
      resolveSafely(target.host, config.resolvers),
    ]);
    base.dns = dns;
    resolved = safe;
    report('dns', 'complete', `Found ${plural(resolved.addresses.length, 'address', 'addresses')}`);
  } catch (error) {
    report('dns', 'failed', 'The address could not be looked up');
    return { ...base, fatalError: `DNS lookup failed — ${errorMessage(error)}` };
  }

  if (resolved.addresses.length === 0) {
    report('dns', 'failed', 'No usable address');
    return { ...base, fatalError: 'This name does not resolve to any address we can reach.' };
  }

  // --- TCP, every address independently ------------------------------------
  report('tcp', 'started', 'Opening a connection…');
  base.addresses = await Promise.all(
    resolved.addresses.map((entry) =>
      probeTcp(entry.address, entry.family, target.port, config.timeouts.connectMs),
    ),
  );

  const reachable = base.addresses.find((a) => a.reachable);
  if (reachable === undefined) {
    report('tcp', 'failed', 'Every connection attempt failed');
    return {
      ...base,
      fatalError: 'We found the address but every connection attempt was refused or timed out.',
    };
  }
  report('tcp', 'complete', `Connected in ${ms(reachable.tcpConnectMs.value ?? 0)}`);

  // --- TLS ------------------------------------------------------------------
  if (target.scheme === 'https') {
    report('tls', 'started', 'Setting up the secure connection…');
    base.tls = await probeTls(reachable.address, target.host, target.port, config.timeouts.tlsMs);
    report(
      'tls',
      base.tls.error === null ? 'complete' : 'failed',
      base.tls.error === null
        ? `Secured with ${base.tls.protocol ?? 'TLS'}`
        : 'The secure connection failed',
    );
  } else {
    report('tls', 'skipped', 'This site does not use encryption');
  }

  // --- HTTP -----------------------------------------------------------------
  report('http', 'started', 'Requesting the page…');
  try {
    const http = await probeHttp({
      url: target.normalizedUrl,
      maxRedirects: config.limits.maxRedirects,
      maxBytes: config.limits.maxResponseBytes,
      timeoutMs: config.timeouts.httpMs,
      resolvers: config.resolvers,
    });

    // node:http speaks HTTP/1.1, so its reported version says nothing about
    // whether the site *supports* HTTP/2. ALPN from the TLS handshake is the
    // honest signal for that, and it is what a browser would actually get.
    const alpn = base.tls?.alpn;
    base.http = {
      ...http,
      httpVersion: alpn === 'h2' ? '2' : http.httpVersion,
    };
    report('http', 'complete', `Responded with ${String(http.status)}`);
  } catch (error) {
    report('http', 'failed', 'The page could not be fetched');
    return { ...base, fatalError: `The request failed — ${errorMessage(error)}` };
  }

  // --- Independent extras, concurrently ------------------------------------
  report('stability', 'started', `Checking consistency over ${config.stabilitySamples} requests…`);
  report('network', 'started', 'Identifying who hosts this site…');

  /*
   * Identity is resolved for every address that answered, not just the first.
   *
   * A single-homed site gets the same answer either way. A site whose addresses
   * sit on different networks — or in different countries — is exactly the case
   * somebody asking "where is this hosted" needs to see, and looking at one
   * address would quietly average it away.
   */
  const identified = base.addresses.filter((a) => a.reachable);

  const [stability, perAddress] = await Promise.all([
    probeStability(
      target.normalizedUrl,
      reachable.address,
      reachable.family,
      config.stabilitySamples,
      config.timeouts.httpMs,
    ),
    Promise.all(
      identified.map(async (entry) => {
        const [network, ptr] = await Promise.all([
          probeAsn(entry.address, config.resolvers),
          probePtr(entry.address, config.resolvers),
        ]);
        return { address: entry.address, network, ptr };
      }),
    ),
  ]);

  const byAddress = new Map(perAddress.map((entry) => [entry.address, entry]));
  base.addresses = base.addresses.map((entry) => {
    const found = byAddress.get(entry.address);
    return found === undefined ? entry : { ...entry, network: found.network, ptr: found.ptr };
  });

  // Kept pointing at the address that answered first, so this stays the same
  // summary it has always been for every report already stored.
  const network = byAddress.get(reachable.address)?.network ?? EMPTY_NETWORK;

  base.stability = stability;
  base.network = network;

  report('stability', 'complete', 'Consistency measured');
  report(
    'network',
    'complete',
    network.asnName === null ? 'Host could not be identified' : `Hosted by ${network.asnName}`,
  );

  return base;
}

/** Convenience wrapper turning phase reports into SSE-ready events. */
export function phaseEvent(
  phase: ProbePhase,
  status: 'started' | 'complete' | 'skipped' | 'failed',
  message: string,
): DiagnosticEvent {
  return { type: 'phase', phase, status, message };
}
