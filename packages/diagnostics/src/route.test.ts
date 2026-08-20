import { describe, expect, it } from 'vitest';
import { analyse } from './engine.js';
import { compareRoute, READER_PENALTY_RATIO, REFERENCE_GAP_FLOOR_MS } from './route.js';
import { makeEvidence, scenarios } from './testing/fixtures.js';

const withReferences = (samples: Record<string, number[]>, extra = {}) =>
  makeEvidence({ referenceSamples: samples, ...extra });

describe('comparing destinations instead of vantages', () => {
  it('takes the quickest reference as the reader’s floor', () => {
    const evidence = withReferences({
      'https://slow.example.net': [180, 182, 179, 181, 180],
      'https://fast.example.net': [40, 41, 39, 42, 40],
    });
    const route = compareRoute(evidence.client!, evidence.server);
    expect(route?.floorOrigin).toBe('https://fast.example.net');
    expect(route?.floorMs).toBe(40);
  });

  /**
   * "No floor established" is not "the route is fine". Collapsing the two would
   * turn an absent measurement into a passing verdict.
   */
  it('has no answer when nothing was reachable', () => {
    const evidence = makeEvidence({});
    expect(compareRoute(evidence.client!, evidence.server)).toBeNull();
  });

  it('has no answer without a target measurement', () => {
    const evidence = withReferences({ 'https://r.example.net': [40, 41, 39, 42, 40] });
    const client = { ...evidence.client!, target: { ...evidence.client!.target, median: null } };
    expect(compareRoute(client, evidence.server)).toBeNull();
  });

  /**
   * A reference answers from a nearby edge, so a target being slower is ordinary
   * — a site genuinely further away costs more and nobody is at fault. Only a
   * gap out of proportion to what our own server pays means anything.
   */
  it('does not blame a route for ordinary distance', () => {
    const route = compareRoute(
      ...(() => {
        const e = withReferences({ 'https://r.example.net': [40, 41, 39, 42, 40] });
        return [e.client!, e.server] as const;
      })(),
    );
    expect(route?.gapMs).toBeLessThan(REFERENCE_GAP_FLOOR_MS);
    expect(route?.readerPaysMore).toBe(false);
  });

  it('flags a gap far larger than the same journey costs our server', () => {
    const evidence = scenarios.localReferencesShowRoute();
    const route = compareRoute(evidence.client!, evidence.server);
    expect(route?.readerPaysMore).toBe(true);
    expect(route?.gapMs).toBeGreaterThan((route?.serverCostMs ?? 0) * READER_PENALTY_RATIO);
  });
});

describe('the route on an install with no paired control', () => {
  /**
   * The point of the whole mechanism: a laptop has a loopback control and can
   * still say something about the route, because references need nothing of our
   * own deployment.
   */
  it('becomes answerable on a local install once references are configured', () => {
    expect(analyse(scenarios.localInstall()).vantages.networkPath.status).toBe('unknown');
    expect(analyse(scenarios.localWithReferences()).vantages.networkPath.status).not.toBe(
      'unknown',
    );
  });

  it('reports a sensible route when the target is in line with the floor', () => {
    const path = analyse(scenarios.localWithReferences()).vantages.networkPath;
    expect(path.status).toBe('ok');
    expect(path.summary).toMatch(/sensible route/i);
  });

  /**
   * Invariant 5: the tile and the findings list are rendered from the same
   * verdict and must not disagree. The reference path used to set the tile to
   * degraded while the finding stayed behind the control-only guard.
   */
  it('emits the finding whenever the tile says the route is degraded', () => {
    const verdict = analyse(scenarios.localReferencesShowRoute());
    expect(verdict.vantages.networkPath.status).toBe('degraded');
    expect(verdict.findings.some((f) => f.code === 'path-degraded')).toBe(true);
  });

  it('names what it measured against, so the number can be checked', () => {
    const finding = analyse(scenarios.localReferencesShowRoute()).findings.find(
      (f) => f.code === 'path-degraded',
    );
    expect(finding?.technical).toContain('reference.example.net');
    expect(finding?.owner).toBe('your-isp');
  });

  it('still refuses when references are configured but none answered', () => {
    const evidence = makeEvidence({
      controlIsLocal: true,
      clientRttSamples: [3, 3, 4, 3, 3],
      referenceSamples: {},
    });
    expect(analyse(evidence).vantages.networkPath.status).toBe('unknown');
  });
});
