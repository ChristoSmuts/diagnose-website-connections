import { CHECK_PHASE_ORDER, type Check, type CheckPhase } from '@dwc/contracts';
import { describe, expect, it } from 'vitest';
import { buildChecks } from './checks.js';
import { analyse } from './engine.js';
import { detectFindings } from './findings/index.js';
import { makeEvidence, scenarios } from './testing/fixtures.js';

const byId = (checks: readonly Check[], id: string): Check => {
  const found = checks.find((c) => c.id === id);
  if (found === undefined) throw new Error(`No check with id "${id}"`);
  return found;
};

describe('checks are the complete record, not just the problems', () => {
  /**
   * The gap this whole feature exists to close: previously a healthy site
   * produced no findings and therefore nothing to expand, which is exactly
   * backwards for a diagnostics tool.
   */
  it('a healthy site still produces a substantial set of checks', () => {
    const verdict = analyse(scenarios.healthy());

    expect(verdict.findings.length).toBeLessThan(5);
    expect(verdict.checks.length).toBeGreaterThan(15);
  });

  it('every check carries a title, summary and real technical detail', () => {
    const verdict = analyse(scenarios.healthy());

    for (const check of verdict.checks) {
      expect(check.title.length, `${check.id} title`).toBeGreaterThan(0);
      expect(check.summary.length, `${check.id} summary`).toBeGreaterThan(0);
      // Layer 3 is where an engineer is served. A one-line restatement of the
      // summary would defeat the point of having the layer at all.
      expect(check.technical.length, `${check.id} technical`).toBeGreaterThan(80);
    }
  });

  it('check ids are unique, so the UI can key on them', () => {
    const ids = analyse(scenarios.healthy()).checks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only links findings that actually fired', () => {
    const verdict = analyse(scenarios.healthy());
    const fired = new Set(verdict.findings.map((f) => f.code));

    for (const check of verdict.checks) {
      for (const code of check.relatedFindings) {
        expect(fired.has(code), `${check.id} links ${code}, which was not detected`).toBe(true);
      }
    }
  });

  it('groups into known phases', () => {
    const phases = new Set(analyse(scenarios.healthy()).checks.map((c) => c.phase));
    for (const phase of phases) {
      expect(CHECK_PHASE_ORDER).toContain(phase);
    }
  });
});

describe('checks stay honest about what was measured', () => {
  /**
   * The Phase 1 bug class, applied to checks.
   *
   * When the control endpoint is on loopback the client vantage is not a
   * statement about anyone's internet, and a check must not present it as one.
   */
  it('reports a loopback control endpoint as unavailable, never as a pass', () => {
    // Single-digit round trips cannot be a real internet path — the API is on
    // this machine, which is the default self-hosted deployment.
    const evidence = makeEvidence({ clientRttSamples: [3, 3, 2, 4, 3] });

    const checks = buildChecks(evidence, detectFindings(evidence, null));
    const latency = byId(checks, 'client.latency');

    expect(latency.status).toBe('unavailable');
    // And it must not put the flattering 3ms on the row.
    expect(latency.headline).toBeNull();
    expect(latency.summary).toMatch(/your own machine/i);
  });

  it('distinguishes "not run" from "ran and could not tell"', () => {
    // No client evidence at all → skipped, because we never asked.
    const serverOnly = scenarios.serverOnly();
    const checks = buildChecks(serverOnly, detectFindings(serverOnly, null));

    expect(byId(checks, 'client.latency').status).toBe('skipped');
    expect(byId(checks, 'client.latency').summary).toMatch(/not run/i);
  });

  it('treats an absent IPv6 address as skipped rather than a failure', () => {
    // An IPv4-only site is entirely normal and must not be reported as broken
    // IPv6 — the false accusation that this distinction exists to prevent.
    const absent = makeEvidence({ ipv6Reachable: null });
    const absentCheck = byId(
      buildChecks(absent, detectFindings(absent, null)),
      'connectivity.ipv6',
    );

    expect(absentCheck.status).toBe('skipped');
    expect(absentCheck.summary).toMatch(/no IPv6 address/i);

    // Published but unreachable is a genuine failure, and must read differently.
    const broken = makeEvidence({ ipv6Reachable: false });
    const brokenCheck = byId(
      buildChecks(broken, detectFindings(broken, null)),
      'connectivity.ipv6',
    );

    expect(brokenCheck.status).toBe('fail');
  });

  it('never states a measured provenance for a value it could not obtain', () => {
    const verdict = analyse(scenarios.unreachable());

    for (const check of verdict.checks) {
      for (const row of check.evidence) {
        if (/^(not measured|not reported|undetermined|not sent|unknown)$/i.test(row.value)) {
          expect(row.provenance, `${check.id} → ${row.label}`).not.toBe('measured');
        }
      }
    }
  });
});

describe('checks reflect the scenario they describe', () => {
  it('marks first-byte time as failing on a slow server', () => {
    const verdict = analyse(scenarios.slowServer());
    const ttfb = byId(verdict.checks, 'http.ttfb');

    expect(ttfb.status).toBe('fail');
    expect(ttfb.relatedFindings).toContain('ttfb-slow');
  });

  it('marks first-byte time as passing on a healthy server', () => {
    expect(byId(analyse(scenarios.healthy()).checks, 'http.ttfb').status).toBe('pass');
  });

  it('reports HTTP checks as unavailable when nothing responded', () => {
    const verdict = analyse(scenarios.unreachable());
    expect(byId(verdict.checks, 'http.response').status).toBe('unavailable');
  });

  /**
   * Three wildly varying samples are noise, not a fact about the site. Treating
   * them as signal is what produced the contradictory verdict "slow to respond
   * (63ms)" beside a health score of 96.
   */
  it('requires enough samples before judging consistency', () => {
    const evidence = makeEvidence({ ttfbSamples: [50, 63, 400] });
    const variance = byId(
      buildChecks(evidence, detectFindings(evidence, null)),
      'stability.variance',
    );

    expect(variance.status).toBe('unavailable');
    expect(variance.summary).toMatch(/too few/i);
  });
});

describe('phase ordering', () => {
  it('emits checks grouped in request order', () => {
    const checks = analyse(scenarios.healthy()).checks;
    const seen: CheckPhase[] = [];
    for (const c of checks) {
      if (seen.at(-1) !== c.phase) seen.push(c.phase);
    }

    // Each phase appears as one contiguous run, in canonical order.
    expect(new Set(seen).size).toBe(seen.length);
    const expected = CHECK_PHASE_ORDER.filter((p) => seen.includes(p));
    expect(seen).toEqual(expected);
  });
});
