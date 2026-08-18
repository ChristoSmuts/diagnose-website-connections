import type { ClientEvidence, Evidence, Finding } from '@dwc/contracts';
import { lossRatio } from '../stats.js';
import { LOCAL_CONTROL_RTT_MS, THRESHOLDS, classify, classifyInverted } from '../thresholds.js';
import { finding, ms } from './helpers.js';

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
  if (client.control.median !== null && client.control.median < LOCAL_CONTROL_RTT_MS) return [];

  const out: Finding[] = [];

  const rtt = client.control.median;
  const rttBand = classify(rtt, THRESHOLDS.clientRttMs);
  if (rtt !== null && (rttBand === 'degraded' || rttBand === 'bad')) {
    out.push(
      finding({
        code: 'client-high-latency',
        severity: rttBand === 'bad' ? 'major' : 'minor',
        owner: 'you',
        title: 'Your connection is slow to respond',
        plain: `A small request from your device to our test server took ${ms(rtt)} to come back. On a healthy connection this is usually under ${THRESHOLDS.clientRttMs.ok} ms.`,
        impact:
          'This delay applies to every website you visit, not just this one. It makes browsing feel sluggish even when sites themselves are fast.',
        technical: `Median round-trip time to the control endpoint was ${ms(rtt)} over ${client.control.count} samples.`,
        evidence: [
          { label: 'Typical round trip', value: ms(rtt) },
          { label: 'Samples', value: String(client.control.count) },
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
  if (client === null || excessMs === null) return out;

  // Loopback control means no usable baseline; assessNetworkPath already
  // returned unknown, so excessMs will be null and we never reach here.
  if (client.control.median !== null && client.control.median < LOCAL_CONTROL_RTT_MS) return out;

  const userLatency = client.control.median ?? 0;
  const serverTime = server.http?.ttfbMs.value ?? 0;
  const actual = client.target.median ?? 0;
  // Same expectation the vantage assessment used, including connection setup —
  // recomputing it differently here is how the two would silently disagree.
  const expected = actual - excessMs;

  if (excessMs > 0 && actual > expected) {
    const ratio = expected > 0 ? actual / expected : 1;
    if (ratio >= 2 && excessMs >= 250) {
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
