import { describe, expect, it } from 'vitest';
import { analyse } from './engine.js';
import { makeEvidence, scenarios } from './testing/fixtures.js';

/**
 * The decision table from the plan, executed.
 *
 * These are the tests that matter most in the whole repo: they assert the one
 * thing the product exists to do, and they do it without touching a network.
 */
describe('attribution decision table', () => {
  it('healthy site + healthy link → healthy', () => {
    const verdict = analyse(scenarios.healthy());
    expect(verdict.culprit).toBe('healthy');
    expect(verdict.score).toBeGreaterThan(80);
  });

  it('slow server + healthy link → server', () => {
    const verdict = analyse(scenarios.slowServer());
    expect(verdict.culprit).toBe('server');
    expect(verdict.vantages.server.status).toBe('bad');
    expect(verdict.vantages.userConnection.status).toBe('ok');
  });

  it('healthy server + poor link → user-connection', () => {
    const verdict = analyse(scenarios.slowClient());
    expect(verdict.culprit).toBe('user-connection');
    expect(verdict.vantages.server.status).toBe('ok');
  });

  it('both ends healthy but the route is slow → network-path', () => {
    const verdict = analyse(scenarios.slowPath());
    expect(verdict.culprit).toBe('network-path');
  });

  it('slow server + poor link → mixed', () => {
    const verdict = analyse(scenarios.both());
    expect(verdict.culprit).toBe('mixed');
  });

  it('nothing answered → unreachable', () => {
    const verdict = analyse(scenarios.unreachable());
    expect(verdict.culprit).toBe('unreachable');
    expect(verdict.score).toBe(0);
  });
});

/**
 * The honesty rules. These guard against the failure mode that would do real
 * damage: telling someone to fight their ISP over another company's slow server.
 */
describe('honesty guarantees', () => {
  it('never blames the user’s connection without having measured it', () => {
    const verdict = analyse(scenarios.serverOnly());

    expect(verdict.culprit).not.toBe('user-connection');
    expect(verdict.culprit).not.toBe('network-path');
    expect(verdict.vantages.userConnection.status).toBe('unknown');
    expect(verdict.vantages.userConnection.score).toBeNull();
  });

  it('still convicts a slow server on server-only evidence, but with lower confidence', () => {
    const verdict = analyse(makeEvidence({ ttfbMs: 1800, clientRttSamples: null }));

    expect(verdict.culprit).toBe('server');
    expect(verdict.confidence).toBe('medium');
    expect(verdict.confidenceReason).toMatch(/browser/i);
  });

  it('explains itself whenever confidence is not high', () => {
    const lowered = [scenarios.serverOnly(), scenarios.slowPath(), scenarios.both()].map(analyse);

    for (const verdict of lowered) {
      if (verdict.confidence !== 'high') {
        expect(verdict.confidenceReason, `${verdict.culprit} gave no reason`).toBeTruthy();
      }
    }
  });

  it('downgrades confidence when built on too few samples', () => {
    const verdict = analyse(makeEvidence({ ttfbMs: 1800, ttfbSamples: [1800] }));

    expect(verdict.confidence).not.toBe('high');
    expect(verdict.confidenceReason).toMatch(/sample/i);
  });

  it('never derives the path from measurements it does not have', () => {
    const verdict = analyse(scenarios.serverOnly());
    expect(verdict.vantages.networkPath.status).toBe('unknown');
  });

  /**
   * Found by running the real app locally, not by unit testing.
   *
   * When the API is self-hosted on the same machine as the browser — the default
   * for local use — the control endpoint answers over loopback in ~3ms. The
   * engine previously read that as a flawless connection and attributed every
   * real internet round trip to the user's ISP, producing a confident
   * "your provider is routing badly" verdict from evidence that did not exist.
   */
  describe('loopback control endpoint', () => {
    const local = () =>
      makeEvidence({
        clientRttSamples: [3, 3, 4, 3, 3],
        clientTargetSamples: [1000, 1010, 990, 1005, 995],
      });

    it('refuses to call a loopback connection healthy', () => {
      const verdict = analyse(local());
      // "Healthy, 3ms" would tell a user on a failing link that their
      // connection is perfect.
      expect(verdict.vantages.userConnection.status).toBe('unknown');
      expect(verdict.vantages.userConnection.summary).toMatch(/own machine/i);
    });

    it('refuses to blame the ISP when it has no baseline to subtract', () => {
      const verdict = analyse(local());
      expect(verdict.vantages.networkPath.status).toBe('unknown');
      expect(verdict.culprit).not.toBe('network-path');
      expect(verdict.findings.some((f) => f.code === 'path-degraded')).toBe(false);
    });

    it('raises no findings about a connection it never measured', () => {
      const verdict = analyse(local());
      expect(verdict.findings.some((f) => f.owner === 'you')).toBe(false);
      expect(verdict.findings.some((f) => f.owner === 'your-isp')).toBe(false);
    });

    it('does not contradict its own tiles in the prose', () => {
      // The tile says "not measured"; the paragraph beside it must not
      // simultaneously claim the connection is healthy at 3ms.
      const verdict = analyse(makeEvidence({ clientRttSamples: [3, 3, 4, 3, 3] }));

      expect(verdict.vantages.userConnection.status).toBe('unknown');
      expect(verdict.plain).not.toMatch(/your own connection also looks healthy/i);
      expect(verdict.plain).not.toMatch(/3 milliseconds round trip/i);
    });
  });

  /**
   * The browser pays DNS, TCP and TLS setup that the server-side TTFB — measured
   * on an already-open connection — does not. Ignoring that overstated the excess
   * by the entire setup cost and manufactured routing problems out of ordinary
   * connection overhead.
   */
  it('counts connection setup when working out what the browser should have paid', () => {
    const evidence = makeEvidence({
      dnsMs: 120,
      tcpMs: 120,
      tlsMs: 160,
      ttfbMs: 100,
      clientRttSamples: [40, 42, 38, 41, 40],
      // 40 + 100 + 400 setup ≈ 540 expected; this is close to it.
      clientTargetSamples: [560, 570, 550, 565, 555],
    });

    const verdict = analyse(evidence);
    expect(verdict.vantages.networkPath.status).toBe('ok');
    expect(verdict.culprit).not.toBe('network-path');
  });
});

/**
 * Layer 1 must work for someone non-technical. These assertions are crude but
 * they catch the most common regression: jargon leaking into the headline.
 */
describe('plain-language layer 1', () => {
  const JARGON = /\b(TTFB|ALPN|OCSP|CNAME|ASN|TLS|TCP|DNS|IQR|p95|RTT|HTTP\/\d)\b/;

  it('keeps jargon out of every headline', () => {
    for (const [name, build] of Object.entries(scenarios)) {
      const verdict = analyse(build());
      expect(verdict.headline, `${name} headline leaked jargon`).not.toMatch(JARGON);
    }
  });

  it('names the site and says who owns the problem', () => {
    const verdict = analyse(scenarios.slowServer());
    expect(verdict.headline).toContain('example.com');
    expect(verdict.headline).toMatch(/their end|not your internet/i);
  });

  it('reassures the user when the fault is not theirs', () => {
    const verdict = analyse(scenarios.slowServer());
    expect(verdict.plain).toMatch(/your connection tested fine|not just you/i);
  });

  it('tells the user it is their connection without blaming the site', () => {
    const verdict = analyse(scenarios.slowClient());
    expect(verdict.headline).toMatch(/your internet connection/i);
    expect(verdict.plain).toMatch(/site itself is healthy/i);
  });
});

describe('findings', () => {
  it('ranks the most severe finding first', () => {
    const verdict = analyse(makeEvidence({ ttfbMs: 2000, compression: null, httpVersion: '1.1' }));

    expect(verdict.findings.length).toBeGreaterThan(1);
    expect(verdict.findings[0]?.severity).toBe('critical');
    expect(verdict.findings[0]?.code).toBe('ttfb-slow');
  });

  it('gives every finding an owner and a fix', () => {
    const verdict = analyse(makeEvidence({ ttfbMs: 1500, compression: null, httpVersion: '1.1' }));

    for (const f of verdict.findings) {
      expect(f.owner, `${f.code} has no owner`).toBeTruthy();
      expect(f.remediation, `${f.code} offers no remediation`).not.toBeNull();
      expect(f.remediation?.steps.length, `${f.code} has empty steps`).toBeGreaterThan(0);
    }
  });

  it('detects a site advertising IPv6 that does not work', () => {
    const verdict = analyse(makeEvidence({ ipv6Reachable: false }));
    const ipv6 = verdict.findings.find((f) => f.code === 'ipv6-broken');

    expect(ipv6).toBeDefined();
    expect(ipv6?.severity).toBe('critical');
    expect(ipv6?.owner).toBe('site-owner');
  });

  it('flags an expired certificate as critical', () => {
    const verdict = analyse(makeEvidence({ certDaysUntilExpiry: -3 }));
    expect(verdict.findings.some((f) => f.code === 'tls-cert-expired')).toBe(true);
  });

  /**
   * Caught by running the app for real: with only three samples the IQR is
   * mostly noise, and a healthy site was reported as "slow to respond (63ms)"
   * beside a health score of 96 — a self-contradicting verdict.
   */
  it('does not let three noisy samples convict a fast site', () => {
    const verdict = analyse(makeEvidence({ ttfbMs: 60, ttfbSamples: [48, 63, 120] }));

    expect(verdict.vantages.server.status).toBe('ok');
    expect(verdict.culprit).toBe('healthy');
  });

  it('still reports variance once there are enough samples', () => {
    const verdict = analyse(
      makeEvidence({ ttfbMs: 300, ttfbSamples: [90, 850, 120, 1400, 110, 980, 130] }),
    );
    expect(verdict.vantages.server.status).not.toBe('ok');
  });

  it('calls an erratic-but-fast site uneven rather than slow', () => {
    const verdict = analyse(
      makeEvidence({ ttfbMs: 80, ttfbSamples: [60, 70, 900, 65, 1100, 75, 80] }),
    );

    expect(verdict.culprit).toBe('server');
    // Describing a 80ms response as "slow" invites the reader to dismiss the
    // whole report as wrong.
    expect(verdict.headline).toMatch(/unevenly/i);
    expect(verdict.headline).not.toMatch(/slow to respond/i);
  });

  it('separates erratic from uniformly slow', () => {
    const verdict = analyse(scenarios.unstable());
    const unstable = verdict.findings.find((f) => f.code === 'unstable-response-times');

    expect(unstable).toBeDefined();
    expect(unstable?.plain).toMatch(/inconsistent rather than uniformly slow/i);
  });

  it('does not bury an unreachable site under secondary complaints', () => {
    const verdict = analyse(scenarios.unreachable());
    expect(verdict.findings.every((f) => !f.code.startsWith('tls-'))).toBe(true);
  });

  it('attributes a slow route to the ISP, not the user or the site', () => {
    const verdict = analyse(scenarios.slowPath());
    const path = verdict.findings.find((f) => f.code === 'path-degraded');

    expect(path?.owner).toBe('your-isp');
    // Inferred, never measured — the path is deduced from both ends.
    expect(path?.confidence).toBe('medium');
  });
});

/**
 * The score is a summary, but a misleading summary is worse than none. A site
 * with a critical finding must not present a comfortable-looking number beside
 * it, and severity must actually move the score.
 */
describe('scoring honesty', () => {
  it('does not award a reassuring score to a site with a critical problem', () => {
    const verdict = analyse(scenarios.slowServer());

    expect(verdict.findings[0]?.severity).toBe('critical');
    expect(verdict.score).toBeLessThan(60);
  });

  it('scales with severity rather than treating everything past a threshold alike', () => {
    const mildly = analyse(makeEvidence({ ttfbMs: 700 })).score;
    const badly = analyse(makeEvidence({ ttfbMs: 1800 })).score;
    const awfully = analyse(makeEvidence({ ttfbMs: 6000 })).score;

    expect(mildly).toBeGreaterThan(badly);
    expect(badly).toBeGreaterThan(awfully);
  });

  it('never lets one healthy vantage average away a broken one', () => {
    // Server is unusable; user connection and path are pristine.
    const verdict = analyse(makeEvidence({ ttfbMs: 8000 }));
    expect(verdict.score).toBeLessThanOrEqual((verdict.vantages.server.score ?? 0) + 10);
  });
});

describe('glossary', () => {
  it('defines only the terms actually used', () => {
    const verdict = analyse(makeEvidence({ compression: null }));
    const terms = verdict.glossary.map((g) => g.term);

    expect(terms).toContain('Compression');
    expect(terms).not.toContain('Packet loss');
  });

  it('leaves the glossary empty when nothing technical was raised', () => {
    expect(analyse(scenarios.healthy()).glossary).toEqual([]);
  });
});

describe('determinism', () => {
  it('produces identical verdicts for identical evidence', () => {
    const evidence = scenarios.slowServer();
    expect(analyse(evidence)).toEqual(analyse(evidence));
  });

  it('stamps the engine version so old reports stay readable', () => {
    expect(analyse(scenarios.healthy()).engineVersion).toBe('1.0.0');
  });
});
