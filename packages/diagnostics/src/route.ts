/**
 * The route to the target, reasoned about without a control endpoint.
 *
 * The control measurement compares **vantages** — what the reader pays against
 * what our server pays — and it breaks whenever our end is closer to the reader
 * than the target is. Loopback, an anycast control, a CDN in front of us: all
 * three leave the baseline too short to subtract, and the leftover gets blamed
 * on the reader's provider when it is really distance.
 *
 * This compares **destinations** instead. Time a couple of well-known public
 * endpoints from the same browser, in the same seconds, over the same link. The
 * quickest of them is roughly the reader's floor — their last mile plus a hop to
 * the nearest well-connected thing. Whatever the target costs above that floor is
 * what reaching *this particular site* costs *this particular reader*.
 *
 * Nothing about our own deployment enters into it, which is the point: it works
 * on a laptop and behind a CDN, where the control cannot anchor anything.
 *
 * Pure, like the rest of the engine: no I/O, no clock, no randomness.
 */

import type { ClientEvidence, ServerEvidence } from '@dwc/contracts';

/**
 * How much worse than the floor a target must be before the gap means anything.
 *
 * References are anycast and answer from a nearby edge, so a target being
 * slower is the normal case rather than a fault — a site genuinely further away
 * costs more to reach and nobody is at fault for that. This is the point past
 * which the gap is worth mentioning at all.
 */
export const REFERENCE_GAP_FLOOR_MS = 120;

/**
 * How much more than our server pays before the extra is the reader's route.
 *
 * Our server reaches the target from a well-connected network. If the reader
 * pays a great deal more than that to reach the same address, the difference is
 * on their side of it — their provider's routing, their peering, their path.
 * Below this multiple the two are close enough that distance and ordinary
 * variation explain it.
 */
export const READER_PENALTY_RATIO = 2.5;

export interface RouteComparison {
  /** The quickest reference, and how quick. The reader's floor. */
  floorMs: number;
  floorOrigin: string;
  /** What the browser paid to reach the target. */
  targetMs: number;
  /** Target minus floor: what this site costs beyond the reader's best case. */
  gapMs: number;
  /** What our server paid for the same thing — connection plus first byte. */
  serverCostMs: number | null;
  /**
   * True when the reader pays disproportionately more than our server does.
   *
   * Inference, never observation. It says the extra is on the reader's side of
   * the target, not which hop, and not whose equipment.
   */
  readerPaysMore: boolean;
}

/**
 * Compare the target against the reader's own floor.
 *
 * Null whenever there is nothing to compare — no references configured, none
 * reachable, or no target measurement. That is a different fact from "the route
 * is fine" and callers must not collapse the two.
 */
export function compareRoute(
  client: ClientEvidence,
  server: ServerEvidence,
): RouteComparison | null {
  const targetMs = client.target.median;
  if (targetMs === null) return null;

  let floorMs: number | null = null;
  let floorOrigin = '';
  for (const reference of client.references) {
    const median = reference.stats.median;
    if (median === null) continue;
    if (floorMs === null || median < floorMs) {
      floorMs = median;
      floorOrigin = reference.origin;
    }
  }
  if (floorMs === null) return null;

  /*
   * What the same journey costs our server: opening the connection plus waiting
   * for the first byte.
   *
   * The browser's figure covers DNS, connection, TLS and the first byte in one
   * opaque number, so the server side is assembled to match rather than using
   * TTFB alone — comparing a full request against a warm-connection TTFB would
   * manufacture a penalty out of ordinary connection setup.
   */
  const connect = server.addresses.find((a) => a.reachable)?.tcpConnectMs.value ?? null;
  const ttfb = server.http?.ttfbMs.value ?? null;
  const tls = server.tls?.handshakeMs.value ?? 0;
  const serverCostMs = connect === null || ttfb === null ? null : connect + tls + ttfb;

  const gapMs = targetMs - floorMs;

  return {
    floorMs,
    floorOrigin,
    targetMs,
    gapMs,
    serverCostMs,
    readerPaysMore:
      serverCostMs !== null &&
      gapMs >= REFERENCE_GAP_FLOOR_MS &&
      gapMs >= serverCostMs * READER_PENALTY_RATIO,
  };
}
