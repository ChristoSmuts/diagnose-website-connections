import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type DetailedPeerCertificate, type TLSSocket } from 'node:tls';
import type { AddressEvidence, Certificate, TlsEvidence } from '@dwc/contracts';
import { measured, unavailable } from '@dwc/contracts';
import { errorMessage, stopwatch } from './timing.ts';

/**
 * TCP connect timing, per resolved address.
 *
 * Every address is probed independently rather than letting the OS pick one.
 * A site whose IPv6 is broken while IPv4 works is slow or dead for visitors on
 * IPv6-first networks and perfectly fine for everyone else — the single most
 * common cause of "it works for me". Collapsing the families would hide it.
 */
export function probeTcp(
  address: string,
  family: 4 | 6,
  port: number,
  timeoutMs: number,
): Promise<AddressEvidence> {
  return new Promise((resolve) => {
    const elapsed = stopwatch();
    const socket: Socket = netConnect({ host: address, port, family });
    socket.setTimeout(timeoutMs);

    const finish = (evidence: AddressEvidence): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(evidence);
    };

    socket.once('connect', () => {
      finish({
        address,
        family,
        reachable: true,
        tcpConnectMs: measured(elapsed(), 'ms'),
        error: null,
      });
    });

    socket.once('timeout', () => {
      finish({
        address,
        family,
        reachable: false,
        tcpConnectMs: unavailable('ms', 'the connection attempt timed out'),
        error: `ETIMEDOUT after ${timeoutMs}ms`,
      });
    });

    socket.once('error', (error) => {
      finish({
        address,
        family,
        reachable: false,
        tcpConnectMs: unavailable('ms', 'the connection was refused or failed'),
        error: errorMessage(error),
      });
    });
  });
}

interface TlsResult {
  handshakeMs: number;
  socket: TLSSocket;
  /** True if the server stapled an OCSP response during this handshake. */
  ocspStapled: boolean;
}

/**
 * One TLS handshake against an already-validated address.
 *
 * `servername` is set explicitly because we connect by IP (to prevent DNS
 * rebinding between validation and connection), and without SNI most shared
 * hosts and every CDN would serve the wrong certificate.
 */
function handshake(
  address: string,
  host: string,
  port: number,
  timeoutMs: number,
  session?: Buffer,
): Promise<TlsResult> {
  return new Promise((resolve, reject) => {
    const elapsed = stopwatch();
    const socket = tlsConnect({
      host: address,
      port,
      servername: host,
      ALPNProtocols: ['h2', 'http/1.1'],
      // We are diagnosing, not trusting: a bad certificate is a finding to
      // report, not a reason to refuse to look. Validity is assessed explicitly
      // from the certificate itself.
      rejectUnauthorized: false,
      // Must be asked for up front — Node only emits 'OCSPResponse' if the
      // status request was included in the ClientHello.
      requestOCSP: true,
      ...(session === undefined ? {} : { session }),
    });

    socket.setTimeout(timeoutMs);

    // Fires before 'secureConnect'. Node emits it with null when the server
    // declined to staple, so the value must be guarded rather than assumed.
    let ocspStapled = false;
    socket.once('OCSPResponse', (response: Buffer | null) => {
      ocspStapled = response !== null && response.length > 0;
    });

    socket.once('secureConnect', () => resolve({ handshakeMs: elapsed(), socket, ocspStapled }));
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`TLS handshake timed out after ${timeoutMs}ms`));
    });
    socket.once('error', (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

export async function probeTls(
  address: string,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<TlsEvidence> {
  let first: TlsResult;
  try {
    first = await handshake(address, host, port, timeoutMs);
  } catch (error) {
    return {
      handshakeMs: unavailable('ms', 'the secure connection could not be established'),
      protocol: null,
      cipher: null,
      alpn: null,
      keyExchange: null,
      certificate: null,
      ocspStapled: null,
      resumedHandshakeMs: unavailable('ms', 'the first handshake failed'),
      resumptionSupported: null,
      error: errorMessage(error),
    };
  }

  const socket = first.socket;

  // Everything must be read BEFORE destroy(): once the socket is torn down
  // getProtocol() and friends return null, which previously showed up as an
  // unknown TLS version on a perfectly healthy site.
  const peer = socket.getPeerCertificate(true);
  const cipher = socket.getCipher();
  const ephemeral = socket.getEphemeralKeyInfo();
  const protocol = socket.getProtocol();
  const alpn = socket.alpnProtocol === false ? null : socket.alpnProtocol;

  const certificate = buildCertificate(peer, host);
  const ocspStapled = first.ocspStapled;

  // Under TLS 1.3 the session ticket arrives *after* the handshake completes,
  // so getSession() immediately after secureConnect is empty. Reading it there
  // made every TLS 1.3 site look like it had resumption disabled — a false
  // accusation against the site owner, which is the exact failure mode this
  // tool exists to avoid.
  const session = await waitForSession(socket, first.socket.getSession());

  socket.destroy();

  // A second handshake reusing the session ticket. The delta against the first
  // is the actual saving a returning visitor gets, which a single handshake
  // cannot show.
  let resumedMs: number | null = null;
  let resumptionSupported: boolean | null = null;
  if (session !== undefined) {
    try {
      const second = await handshake(address, host, port, timeoutMs, session);
      resumedMs = second.handshakeMs;
      resumptionSupported = second.socket.isSessionReused();
      second.socket.destroy();
    } catch {
      // The second connection failed for some network reason. That tells us
      // nothing about resumption support, so it stays unknown rather than
      // becoming an accusation.
      resumptionSupported = null;
    }
  } else {
    // No ticket was ever offered. Genuinely inconclusive — some servers only
    // issue one after application data — so report unknown, not "unsupported".
    resumptionSupported = null;
  }

  return {
    handshakeMs: measured(first.handshakeMs, 'ms'),
    protocol,
    cipher: cipher.name,
    alpn,
    keyExchange: describeKeyExchange(ephemeral),
    certificate,
    ocspStapled,
    resumedHandshakeMs:
      resumedMs === null
        ? unavailable('ms', 'the connection could not be resumed')
        : measured(resumedMs, 'ms'),
    resumptionSupported,
    error: null,
  };
}

/**
 * Obtain a session that can actually be resumed with.
 *
 * Subtle and worth spelling out: under TLS 1.3, `getSession()` returns a
 * populated buffer the moment the handshake finishes, but that is a *pre-ticket*
 * session which will not resume. The usable NewSessionTicket arrives shortly
 * afterwards as a separate post-handshake message, via the 'session' event.
 *
 * Using the early buffer meant every TLS 1.3 site failed the resumption test and
 * got told to enable something they already had switched on — a false accusation
 * against the site owner, which is exactly what this tool must never do. So we
 * always wait briefly for the real ticket and only fall back to whatever was
 * available at handshake time (which is the correct value for TLS 1.2).
 */
function waitForSession(socket: TLSSocket, existing: Buffer | undefined): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off('session', onSession);
      resolve(existing);
    }, 1500);

    function onSession(session: Buffer): void {
      clearTimeout(timer);
      resolve(session);
    }

    socket.once('session', onSession);
  });
}

/**
 * getEphemeralKeyInfo() is typed as `object | EphemeralKeyInfo | null` because
 * it returns an empty object for non-ephemeral key exchanges, so the shape has
 * to be checked at runtime rather than asserted.
 */
function describeKeyExchange(info: ReturnType<TLSSocket['getEphemeralKeyInfo']>): string | null {
  if (info === null || typeof info !== 'object' || !('type' in info)) return null;

  const { type, size } = info as { type?: unknown; size?: unknown };
  if (typeof type !== 'string' || type.length === 0) return null;

  return typeof size === 'number' ? `${type} ${String(size)}` : type;
}

type PeerCertificate = DetailedPeerCertificate;

function buildCertificate(peer: PeerCertificate, host: string): Certificate | null {
  if (peer === null || Object.keys(peer).length === 0) return null;

  const validTo = new Date(peer.valid_to);
  const daysUntilExpiry = (validTo.getTime() - Date.now()) / 86_400_000;
  const altNames = parseAltNames(peer.subjectaltname);

  return {
    subject: formatName(peer.subject),
    issuer: formatName(peer.issuer),
    validFrom: safeIso(peer.valid_from),
    validTo: safeIso(peer.valid_to),
    daysUntilExpiry,
    subjectAltNames: altNames,
    hostnameMatches: matchesHost(host, altNames, peer.subject?.CN),
    chainLength: countChain(peer),
    selfSigned: formatName(peer.subject) === formatName(peer.issuer),
  };
}

const safeIso = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
};

function formatName(name: Record<string, unknown> | undefined): string {
  if (name === undefined) return 'unknown';
  const cn = name.CN;
  const o = name.O;
  if (typeof cn === 'string' && cn.length > 0) return cn;
  if (typeof o === 'string' && o.length > 0) return o;
  return 'unknown';
}

const parseAltNames = (raw: string | undefined): string[] =>
  raw === undefined
    ? []
    : raw
        .split(',')
        .map((part) => part.trim().replace(/^DNS:/i, ''))
        .filter((part) => part.length > 0);

/**
 * Certificate hostname matching, including single-level wildcards.
 *
 * `*.example.com` covers `www.example.com` but deliberately NOT
 * `a.b.example.com` nor the bare `example.com` — treating it as covering either
 * would report a genuinely broken certificate as valid.
 */
export function matchesHost(
  host: string,
  altNames: readonly string[],
  commonName?: unknown,
): boolean {
  const candidates = [...altNames];
  if (typeof commonName === 'string' && commonName.length > 0) candidates.push(commonName);

  const target = host.toLowerCase();

  return candidates.some((raw) => {
    const name = raw.toLowerCase();
    if (name === target) return true;
    if (!name.startsWith('*.')) return false;

    const suffix = name.slice(1); // ".example.com"
    if (!target.endsWith(suffix)) return false;

    // Exactly one extra label to the left.
    const prefix = target.slice(0, target.length - suffix.length);
    return prefix.length > 0 && !prefix.includes('.');
  });
}

function countChain(peer: PeerCertificate): number {
  let depth = 0;
  let current: PeerCertificate | undefined = peer;
  const seen = new Set<string>();

  while (current !== undefined && Object.keys(current).length > 0) {
    const fingerprint = current.fingerprint ?? String(depth);
    // A self-signed root points at itself, which would otherwise loop forever.
    if (seen.has(fingerprint)) break;
    seen.add(fingerprint);
    depth += 1;
    current = current.issuerCertificate as PeerCertificate | undefined;
  }

  return depth;
}
