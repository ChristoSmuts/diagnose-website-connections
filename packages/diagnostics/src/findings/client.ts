import type { ClientEvidence, Evidence, Finding } from '@dwc/contracts';
import { distanceCeilingKm } from '../location.js';
import { compareRoute } from '../route.js';
import { lossRatio } from '../stats.js';
import {
  DISTANT_ORIGIN_RTT_MS,
  PATH_DEGRADATION,
  THRESHOLDS,
  classify,
  classifyInverted,
  clientRttBand,
  controlIsLoopback,
} from '../thresholds.js';
import { finding, hostOf, ms } from './helpers.js';

/**
 * Findings about the user's own connection.
 *
 * Every one of these is measured against our control endpoint rather than the
 * target, which is what makes them safe to state: they hold regardless of
 * whatever the site being tested is doing.
 */
export function detectClientFindings(client: ClientEvidence | null): Finding[] {
  if (client === null) return [];

  // Loopback control: nothing here describes the user's internet connection, so
  // raising findings about it would be inventing evidence. See assessUserConnection.
  if (controlIsLoopback(client)) return [];

  const out: Finding[] = [];

  /*
   * Judged against whichever band matches the instrument.
   *
   * A paired instance is asked for a near-empty body it grants us permission to
   * read; anything else is timed opaquely, whole response and all. Reporting the
   * second against the first accused a fibre line of being slow, so the band, the
   * wording and the confidence all follow `controlIsPaired`.
   */
  const opaque = client.controlIsPaired === false;
  const against = client.controlOrigin === null ? null : hostOf(client.controlOrigin);
  const band = clientRttBand(client);

  const rtt = client.control.median;
  const rttStatus = classify(rtt, band);
  if (rtt !== null && (rttStatus === 'degraded' || rttStatus === 'bad')) {
    out.push(
      finding({
        code: 'client-high-latency',
        severity: rttStatus === 'bad' ? 'major' : 'minor',
        owner: 'you',
        /*
         * An opaque measurement cannot separate the network from whatever the far
         * end did before answering, and that endpoint is the operator's choice
         * rather than the reader's. Enough to raise, not enough to be certain.
         */
        confidence: opaque ? 'medium' : 'high',
        title: 'Your connection is slow to respond',
        plain: opaque
          ? `A request from your device to ${against ?? 'the test endpoint'} took ${ms(rtt)} to come back. This times a whole request and reply, so it reads higher than the latency figure a speed test gives you — under ${String(band.ok)} ms is the healthy range here.`
          : `A small request from your device to our test server took ${ms(rtt)} to come back. On a healthy connection this stays under ${String(band.ok)} ms.`,
        impact:
          'This delay applies to every website you visit, not just this one. It makes browsing feel sluggish even when sites themselves are fast.',
        technical: opaque
          ? `Median round trip to ${client.controlOrigin ?? 'the control endpoint'} was ${ms(rtt)} over ${String(client.control.count)} samples, timed with an opaque no-cors fetch. That settles on the complete response rather than after reading a known-empty body, so it includes request framing and any work the endpoint does before replying — neither of which can be separated out from here. Judged against ${String(band.ok)}/${String(band.degraded)} ms, not the ${String(THRESHOLDS.clientRttMs.ok)}/${String(THRESHOLDS.clientRttMs.degraded)} ms band used for a paired instance's /api/ping.`
          : `Median round-trip time to the control endpoint was ${ms(rtt)} over ${String(client.control.count)} samples.`,
        evidence: [
          { label: 'Typical round trip', value: ms(rtt) },
          { label: 'Samples', value: String(client.control.count) },
          ...(against === null ? [] : [{ label: 'Measured against', value: against }]),
        ],
        remediation: {
          summary: 'Check your local network before blaming anything else.',
          steps: [
            'If you are on Wi-Fi, try moving closer to the router or switching to a cable — this is the most common cause by far.',
            'Restart your router; it fixes a surprising share of latency problems.',
            'Check whether other devices or downloads are saturating the connection.',
            'If it stays high on a wired connection with nothing else running, contact your provider with these numbers.',
          ],
        },
      }),
    );
  }

  const jitter = client.control.jitter;
  const jitterBand = classify(jitter, THRESHOLDS.clientJitterMs);
  if (jitter !== null && (jitterBand === 'degraded' || jitterBand === 'bad')) {
    out.push(
      finding({
        code: 'client-high-jitter',
        severity: jitterBand === 'bad' ? 'major' : 'minor',
        owner: 'you',
        title: 'Your connection speed keeps changing',
        plain: `The time your connection took varied by about ${ms(jitter)} between one request and the next, rather than staying steady.`,
        impact:
          'Inconsistency like this is what makes video calls stutter and streams re-buffer, even when the average speed looks perfectly fine.',
        technical: `Mean consecutive delta was ${ms(jitter)} against a median of ${ms(client.control.median ?? 0)}.`,
        evidence: [
          { label: 'Variation between requests', value: ms(jitter) },
          { label: 'Typical round trip', value: ms(client.control.median ?? 0) },
        ],
        remediation: {
          summary: 'Usually Wi-Fi interference or a congested link.',
          steps: [
            'Try a wired connection to rule out Wi-Fi entirely.',
            'Switch your Wi-Fi to the 5GHz band, or change channel if neighbouring networks overlap.',
            'Check whether something else on the network is uploading or downloading in the background.',
          ],
        },
      }),
    );
  }

  const loss = lossRatio(client.control);
  const lossBand = classify(loss, THRESHOLDS.clientLossRatio);
  if (loss !== null && loss > 0 && (lossBand === 'degraded' || lossBand === 'bad')) {
    out.push(
      finding({
        code: 'client-packet-loss',
        severity: lossBand === 'bad' ? 'critical' : 'major',
        owner: 'you',
        confidence: client.control.count >= 10 ? 'high' : 'medium',
        title: 'Some of your requests never arrived',
        plain: `${(loss * 100).toFixed(0)}% of our test requests from your device got no reply at all.`,
        impact:
          'Lost data has to be sent again, which causes sudden stalls and is far more damaging to browsing than a merely slow connection.',
        technical: `${client.control.failed} of ${client.control.count + client.control.failed} probes failed or timed out.`,
        evidence: [
          {
            label: 'Failed requests',
            value: `${client.control.failed} of ${client.control.count + client.control.failed}`,
          },
        ],
        remediation: {
          summary: 'Packet loss almost always means faulty hardware or a weak signal.',
          steps: [
            'Test with a cable — if the loss disappears, the problem is Wi-Fi.',
            'Check cables and connectors for damage.',
            'If loss persists on a wired connection, report it to your provider; this is their equipment or line.',
          ],
        },
      }),
    );
  }

  if (client.throughput?.consented) {
    const down = client.throughput.downloadBps.value;
    const band = classifyInverted(down, THRESHOLDS.throughputBps);
    if (down !== null && (band === 'degraded' || band === 'bad')) {
      out.push(
        finding({
          code: 'client-low-throughput',
          severity: band === 'bad' ? 'major' : 'minor',
          owner: 'you',
          confidence: 'medium',
          title: 'Your connection has limited bandwidth',
          plain: `Your download speed measured about ${(down / 125_000).toFixed(1)} Mbps.`,
          impact: 'Large pages, images and video take proportionally longer to arrive.',
          technical: `Measured ${(down / 1_000_000).toFixed(2)} MB/s downstream. Short in-browser tests understate fast links, so treat this as a floor rather than an exact figure.`,
          evidence: [
            {
              label: 'Download speed',
              value: `${(down / 125_000).toFixed(1)} Mbps`,
              provenance: 'measured',
            },
          ],
          remediation: {
            summary: 'Confirm with a dedicated speed test before acting.',
            steps: [
              'Check what speed your plan is supposed to provide.',
              'Make sure nothing else is using the connection during the test.',
              'Wi-Fi frequently limits throughput well below the line speed — retest wired before contacting your provider.',
            ],
          },
        }),
      );
    }
  }

  return out;
}

/**
 * The path between the two endpoints.
 *
 * Necessarily inferred: we compare what the user's experience *should* cost,
 * given both ends, against what it actually cost. Confidence is capped at
 * medium throughout because nothing here is directly observed.
 */
export function detectPathFindings(evidence: Evidence, excessMs: number | null): Finding[] {
  const out: Finding[] = [];
  const { server, client } = evidence;

  const userLatency = client?.control.median ?? 0;
  const serverTime = server.http?.ttfbMs.value ?? 0;
  const actual = client?.target.median ?? 0;
  // Same expectation the vantage assessment used, including connection setup —
  // recomputing it differently here is how the two would silently disagree.
  const expected = actual - (excessMs ?? 0);

  /*
   * Only `path-degraded` needs the subtraction; the two findings below do not.
   *
   * This whole function used to return early when `excessMs` was null, which is
   * the case on every local install and behind every unpaired or edge-terminated
   * control. That silently suppressed `no-cdn` — which reads no browser evidence
   * at all — and `origin-geographically-distant`, which needs the browser's time
   * to the target but nothing about the control. The effect was a local report
   * that scored the same site 100 where a hosted one scored 96, purely because
   * findings it was entitled to make never fired.
   */
  const canSubtract = client !== null && excessMs !== null && !controlIsLoopback(client);

  let pathDegraded = false;
  if (canSubtract && excessMs !== null && excessMs > 0 && actual > expected) {
    const ratio = expected > 0 ? actual / expected : 1;
    if (ratio >= PATH_DEGRADATION.ratio && excessMs >= PATH_DEGRADATION.absoluteFloorMs) {
      pathDegraded = true;
      out.push(
        finding({
          code: 'path-degraded',
          severity: excessMs > 800 ? 'major' : 'minor',
          owner: 'your-isp',
          confidence: 'medium',
          title: 'Traffic between you and this site takes a slow route',
          plain: `Your connection is healthy and the site responds quickly to us, yet reaching it from your device costs about ${ms(excessMs)} more than those two facts together explain.`,
          impact:
            'This site feels slower to you than it does to other people, even though nothing is wrong with either your connection or the site itself.',
          technical: `Observed ${ms(actual)} from the browser against an expected ${ms(expected)} (your own latency ${ms(userLatency)} + the server's response time ${ms(serverTime)} + connection setup). Excess ${ms(excessMs)}. Derived by comparing vantage points rather than measured directly.`,
          evidence: [
            { label: 'Actual, from your browser', value: ms(actual) },
            { label: 'Expected', value: ms(expected), provenance: 'inferred' },
            { label: 'Unexplained excess', value: ms(excessMs), provenance: 'inferred' },
          ],
          remediation: {
            summary: 'Little you can do directly, but worth confirming and reporting.',
            steps: [
              'Try the site over a different network — mobile data is an easy comparison. If it is fast there, the route your provider uses is the problem.',
              'A VPN sometimes bypasses a poor route, which also confirms the diagnosis.',
              'Report it to your provider with these figures; routing problems are theirs to fix.',
            ],
          },
        }),
      );
    }
  }

  /*
   * The same conclusion, reached the other way.
   *
   * When the control could not anchor the subtraction, `assessNetworkPath` falls
   * back to comparing destinations — the target against the quickest reference
   * endpoint. If that produced a verdict, this has to produce the matching
   * finding, or the tile says "degraded" beside a list that mentions nothing.
   */
  if (!canSubtract && client !== null) {
    const route = compareRoute(client, server);
    if (route !== null && route.readerPaysMore) {
      pathDegraded = true;
      out.push(
        finding({
          code: 'path-degraded',
          severity: route.gapMs > 800 ? 'major' : 'minor',
          owner: 'your-isp',
          confidence: 'medium',
          title: 'Traffic between you and this site takes a slow route',
          plain: `Reaching this site from your device costs about ${ms(route.gapMs)} more than reaching a well-connected reference endpoint, and the site itself answers us quickly.`,
          impact:
            'This site feels slower to you than it does to other people, even though nothing is wrong with either your connection or the site itself.',
          technical: `Your browser reached ${route.floorOrigin} in ${ms(route.floorMs)} and this site in ${ms(route.targetMs)}, a gap of ${ms(route.gapMs)} — against ${route.serverCostMs === null ? 'an unknown' : ms(route.serverCostMs)} for the same connection and first byte from our own server. Both browser figures were measured over your link within seconds of each other, so the difference is what reaching this particular site costs you beyond your own best case. Inferred by comparing destinations rather than vantages, which is what makes it available without a paired control endpoint.`,
          evidence: [
            { label: 'This site, from your browser', value: ms(route.targetMs) },
            { label: `Reference (${route.floorOrigin})`, value: ms(route.floorMs) },
            { label: 'Gap', value: ms(route.gapMs), provenance: 'inferred' },
            {
              label: 'The same journey from our server',
              value: route.serverCostMs === null ? 'not measured' : ms(route.serverCostMs),
              provenance: route.serverCostMs === null ? 'unavailable' : 'measured',
            },
          ],
          remediation: {
            summary: 'Little you can do directly, but worth confirming and reporting.',
            steps: [
              'Try the site over a different network — mobile data is an easy comparison. If it is fast there, the route your provider uses is the problem.',
              'A VPN sometimes bypasses a poor route, which also confirms the diagnosis.',
              'Report it to your provider with these figures; routing problems are theirs to fix.',
            ],
          },
        }),
      );
    }
  }

  /*
   * Distance as the explanation of last resort.
   *
   * Only reached once the two competing explanations are ruled out: a CDN would
   * have put a copy near the reader, and a bad route would have shown up as
   * unexplained excess above. What remains on a round trip this long is the
   * length of the wire.
   *
   * Owner is nobody, deliberately. The distance itself is geography and nobody
   * can shorten it; putting a CDN in front is a real fix, but that advice belongs
   * to `no-cdn` below, which owns it. Two findings offering the same remediation
   * would read as two problems.
   */
  const ceilingKm = distanceCeilingKm(actual);
  if (
    client !== null &&
    server.network.cdnDetected === null &&
    actual >= DISTANT_ORIGIN_RTT_MS &&
    !pathDegraded &&
    server.network.asnName !== null
  ) {
    out.push(
      finding({
        code: 'origin-geographically-distant',
        severity: 'info',
        owner: 'nobody',
        confidence: 'medium',
        title: 'The site is a long way from you',
        plain: `Reaching this site from your device takes about ${ms(actual)} for a round trip, and neither your connection nor the site's own speed accounts for it. It is served from one place, and that place is far away.`,
        impact:
          'Every request pays that distance again. Pages with many separate files feel it most, because the delay is repeated rather than shared.',
        technical: `Round trip from the browser ${ms(actual)}, with no unexplained routing excess and no CDN detected in front of ${server.network.asnName}${server.network.country === null ? '' : ` (${server.network.country})`}. At roughly 200 km per millisecond through fibre, that round trip is consistent with a distance of up to ${ceilingKm === null ? 'anywhere on Earth' : `${ceilingKm.toLocaleString('en-GB')} km`} — an upper bound, not a position. Distance is inferred here by elimination rather than observed: latency can also be inflated by queueing or a slow route, which is why this is only reported once both have been ruled out.`,
        evidence: [
          { label: 'Round trip from your browser', value: ms(actual) },
          {
            label: 'Serving network',
            value: server.network.asnName,
            provenance: 'measured',
          },
          {
            label: 'Furthest it could be',
            value:
              ceilingKm === null
                ? 'unbounded — no constraint at this latency'
                : `${ceilingKm.toLocaleString('en-GB')} km`,
            provenance: ceilingKm === null ? 'unavailable' : 'inferred',
          },
        ],
        remediation: {
          summary: 'Nothing you can do about this directly — it is the distance.',
          steps: [
            'If the site matters to you regularly, its owner adding a content delivery network is the fix, and that is covered separately below.',
          ],
        },
      }),
    );
  }

  if (server.network.cdnDetected === null && server.network.asnName !== null) {
    out.push(
      finding({
        code: 'no-cdn',
        severity: 'info',
        owner: 'site-owner',
        confidence: 'medium',
        title: 'The site is served from one location',
        plain: `This site appears to be hosted directly by ${server.network.asnName} rather than distributed across a content network.`,
        impact:
          'Visitors far from that location wait longer, and everyone shares the same origin server during traffic spikes.',
        technical: `Origin ASN ${server.network.asn ?? 'unknown'} (${server.network.asnName}); no known CDN signature matched.`,
        evidence: [
          { label: 'Hosted by', value: server.network.asnName },
          { label: 'Network', value: server.network.asn ?? 'unknown' },
          { label: 'Country', value: server.network.country ?? 'unknown' },
        ],
        remediation: {
          summary: 'A CDN puts copies of the site near every visitor.',
          steps: [
            'Several CDNs have capable free tiers that need only a DNS change.',
            'This typically improves connection and TLS time far more than tuning the origin server ever will.',
          ],
        },
      }),
    );
  }

  return out;
}
