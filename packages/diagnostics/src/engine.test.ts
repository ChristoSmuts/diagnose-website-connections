import { describe, expect, it } from 'vitest';
import { analyse, ENGINE_VERSION } from './engine.js';
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
  describe('no loopback figure is ever presented as the reader’s', () => {
    /**
     * The Phase 1 bug has now been fixed in three separate places: the narration,
     * the client checks, and — found much later — the route check, which printed
     * "Your round trip: 2 ms" with a measured badge directly beneath a summary
     * saying nothing could be judged because the tool was running on the reader's
     * own machine.
     *
     * Guarding each site individually is what let the third one hide, so this
     * sweeps the whole rendered verdict instead. The control median is a value no
     * other fixture measurement produces, so finding it badged as measured
     * anywhere means something is passing loopback off as the reader's link.
     */
    const LOOPBACK_MS = 3;
    const local = () =>
      makeEvidence({
        clientRttSamples: [LOOPBACK_MS, LOOPBACK_MS, LOOPBACK_MS, LOOPBACK_MS, LOOPBACK_MS],
        controlIsLocal: true,
      });

    it('never badges the loopback round trip as measured, in any check', () => {
      const offenders = analyse(local())
        .checks.flatMap((check) => check.evidence.map((row) => ({ check: check.id, ...row })))
        .filter(
          (row) => row.provenance === 'measured' && row.value === `${String(LOOPBACK_MS)} ms`,
        );

      expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
    });

    /**
     * Broader than matching one value, because matching one value is what let the
     * 95th percentile slip through beside a guarded median.
     *
     * Every duration in the client phase describes the reader's link, and over
     * loopback there is no such measurement — so none of them may claim to be
     * one. Counts and ratios are exempt: they describe our probing, not the link.
     */
    it('states no duration at all about a connection it did not measure', () => {
      const offenders = analyse(local())
        .checks.filter((check) => check.phase === 'client')
        .flatMap((check) => check.evidence.map((row) => ({ check: check.id, ...row })))
        .filter((row) => / ms$/.test(row.value) && row.provenance === 'measured');

      expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
    });

    it('never states it in a finding either', () => {
      const offenders = analyse(local())
        .findings.flatMap((finding) =>
          finding.evidence.map((row) => ({ code: finding.code, ...row })),
        )
        .filter(
          (row) => row.provenance === 'measured' && row.value === `${String(LOOPBACK_MS)} ms`,
        );

      expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
    });

    /** The specific row that was wrong, named so the regression is legible. */
    it('says why the round trip is missing rather than showing loopback', () => {
      const row = analyse(local())
        .checks.find((check) => check.id === 'path.excess')
        ?.evidence.find((entry) => entry.label === 'Your round trip');

      expect(row?.provenance).toBe('unavailable');
      expect(row?.value).toMatch(/on this machine/i);
    });
  });

  describe('a control endpoint behind a CDN edge', () => {
    /**
     * The nastiest of the three, because nothing looks wrong: the control is a
     * genuine instance of this app on a public hostname, and the round trip is a
     * real internet measurement. It simply ended at an edge near the reader, so
     * it is short by however far the target actually is — and the leftover, which
     * the route verdict hands to the reader's provider, is really distance.
     */
    it('refuses to judge the route, and blames no provider for distance', () => {
      const verdict = analyse(scenarios.edgeTerminatedControl());
      expect(verdict.vantages.networkPath.status).toBe('unknown');
      expect(verdict.culprit).not.toBe('network-path');
      expect(verdict.findings.some((f) => f.code === 'path-degraded')).toBe(false);
    });

    it('still judges the reader’s own connection', () => {
      // An edge baseline describes the last mile honestly. Only the subtraction
      // is invalid, so this vantage must survive.
      expect(analyse(scenarios.edgeTerminatedControl()).vantages.userConnection.status).not.toBe(
        'unknown',
      );
    });

    it('says what would make the route measurable', () => {
      const summary = analyse(scenarios.edgeTerminatedControl()).vantages.networkPath.summary;
      expect(summary).toMatch(/content delivery network/i);
      expect(summary).toMatch(/directly/i);
    });
  });

  describe('findings that never needed the control endpoint', () => {
    /**
     * `detectPathFindings` used to return early whenever the route could not be
     * judged, which silently suppressed two findings that do not use the control
     * measurement at all — `no-cdn` reads no browser evidence whatsoever. The
     * effect was a local install quietly making fewer accusations than a hosted
     * one about identical evidence.
     */
    const withoutCdn = (extra = {}) => makeEvidence({ cdn: null, ...extra });

    it('reports a missing CDN however the control endpoint is deployed', () => {
      const cases = {
        remote: withoutCdn(),
        loopback: withoutCdn({ controlIsLocal: true, clientRttSamples: [3, 3, 4, 3, 3] }),
        unpaired: withoutCdn({ controlIsPaired: false }),
        edge: withoutCdn({ controlIsEdgeTerminated: true }),
        'no browser at all': withoutCdn({ clientRttSamples: null }),
      };

      for (const [name, evidence] of Object.entries(cases)) {
        const codes = analyse(evidence).findings.map((f) => f.code);
        expect(codes, name).toContain('no-cdn');
      }
    });
  });

  describe('a control endpoint that is not another instance', () => {
    /**
     * CONTROL_URL may point anywhere the browser can reach, timed opaquely. That
     * is enough to characterise the reader's own link and deliberately not enough
     * to judge the route: subtracting a baseline taken against a nearby anycast
     * edge from the time to a distant target manufactures excess out of ordinary
     * geography, and the report would hand that excess to the reader's provider.
     */
    const unpaired = () =>
      makeEvidence({
        clientRttSamples: [22, 24, 21, 23, 22],
        clientTargetSamples: [520, 530, 515, 525, 522],
        controlOrigin: 'https://www.google.com',
        controlIsPaired: false,
      });

    it('still judges the reader’s own connection', () => {
      const verdict = analyse(unpaired());
      expect(verdict.vantages.userConnection.status).not.toBe('unknown');
    });

    it('refuses to judge the route, and blames no provider for distance', () => {
      const verdict = analyse(unpaired());
      expect(verdict.vantages.networkPath.status).toBe('unknown');
      expect(verdict.culprit).not.toBe('network-path');
      expect(verdict.findings.some((f) => f.code === 'path-degraded')).toBe(false);
    });

    it('says why, and how to get the route measured too', () => {
      const verdict = analyse(unpaired());
      expect(verdict.vantages.networkPath.summary).toMatch(/not another instance/i);
      expect(verdict.vantages.networkPath.summary).toMatch(/CONTROL_URL/);
    });

    /**
     * The Cape Town false accusation, in one test.
     *
     * An opaque control is a different instrument from a paired `/api/ping`: the
     * fetch settles on the whole response rather than after a known-empty body,
     * and the endpoint is a third party doing unknown work. Measured on a 100 Mb
     * line, the same URL fetched both ways came back 15 ms readable and 24 ms
     * opaque — small, systematic, and always upward.
     *
     * Held to the ping band, a reader sitting just under 60 ms readable tips over
     * it on the instrument alone and is told their connection is slow. 68 ms is
     * exactly that: past `clientRttMs.ok` (60) and inside `clientRttOpaqueMs.ok`
     * (75).
     */
    const nearBoundary = (paired: boolean) =>
      makeEvidence({
        clientRttSamples: [68, 68, 68, 68, 68],
        controlOrigin: 'https://www.gstatic.com',
        controlIsPaired: paired,
      });

    it('does not call a healthy link slow just because it was timed opaquely', () => {
      const verdict = analyse(nearBoundary(false));

      expect(verdict.vantages.userConnection.status).toBe('ok');
      expect(verdict.findings.some((f) => f.code === 'client-high-latency')).toBe(false);
    });

    it('still calls the same figure degraded when a paired instance produced it', () => {
      const verdict = analyse(nearBoundary(true));

      expect(verdict.vantages.userConnection.status).toBe('degraded');
      expect(verdict.findings.some((f) => f.code === 'client-high-latency')).toBe(true);
    });

    /**
     * The wider band must not become a blanket excuse. A genuinely bad link is
     * several hundred milliseconds, and no instrument accounts for that.
     */
    it('still convicts a genuinely slow link measured opaquely', () => {
      const verdict = analyse(
        makeEvidence({
          clientRttSamples: [400, 410, 395, 405, 402],
          controlOrigin: 'https://www.gstatic.com',
          controlIsPaired: false,
        }),
      );

      expect(verdict.vantages.userConnection.status).toBe('bad');
      expect(verdict.findings.some((f) => f.code === 'client-high-latency')).toBe(true);
    });

    it('does not present an opaque page fetch as if it were a ping', () => {
      const verdict = analyse(
        makeEvidence({
          clientRttSamples: [400, 410, 395, 405, 402],
          controlOrigin: 'https://www.gstatic.com',
          controlIsPaired: false,
        }),
      );

      const latency = verdict.findings.find((f) => f.code === 'client-high-latency');
      expect(latency?.plain).toContain('www.gstatic.com');
      expect(latency?.plain).not.toMatch(/small request/i);
      // The endpoint's own work is folded in and cannot be separated out.
      expect(latency?.confidence).toBe('medium');
    });

    it('keeps judging the route when the endpoint is a paired instance', () => {
      const verdict = analyse(scenarios.remoteControl());
      expect(verdict.vantages.networkPath.status).not.toBe('unknown');
    });
  });

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

  /**
   * Asserts the invariant, not the literal.
   *
   * Pinning the exact string meant every deliberate bump failed a test that was
   * not actually protecting anything. What matters is that the stamp is present,
   * is real semver, and agrees with the exported constant — because a stored
   * report is only readable in its original terms if that number is trustworthy.
   */
  it('stamps the engine version so old reports stay readable', () => {
    const stamped = analyse(scenarios.healthy()).engineVersion;
    expect(stamped).toBe(ENGINE_VERSION);
    expect(stamped).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
