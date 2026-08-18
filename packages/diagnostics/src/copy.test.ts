import { describe, expect, it } from 'vitest';
import { analyse } from './engine.js';
import { makeEvidence, scenarios } from './testing/fixtures.js';

/**
 * Copy tests: the structural half of the voice rules.
 *
 * These cannot judge whether the writing is good — only reading it can do that.
 * What they can do is catch the specific ways this report has told lies before,
 * each of which shipped and was found by eye rather than by a test:
 *
 *  1. Stating a number for a vantage that was never measured.
 *  2. A headline contradicting the content directly beneath it.
 *
 * See .claude/skills/report-voice/SKILL.md for the rules these enforce.
 */

const ALL_SCENARIOS = Object.entries(scenarios).map(([name, build]) => ({ name, build }));

/** Every user-facing string in Layer 1 and Layer 2. */
function layer1and2(verdict: ReturnType<typeof analyse>): string[] {
  return [
    verdict.headline,
    verdict.plain,
    ...verdict.findings.flatMap((f) => [f.title, f.plain, f.impact]),
    ...Object.values(verdict.vantages).flatMap((v) => [v.label, v.summary]),
  ];
}

describe('never claims a number it did not measure', () => {
  /**
   * The loopback bug, guarded structurally.
   *
   * With the API on localhost the control endpoint answers in ~3ms, which says
   * nothing about anyone's internet. The tiles report "not measured"; the prose
   * used to say "your connection also looks healthy, at 3ms round trip" directly
   * beside it.
   */
  it('says nothing about round-trip time when the client vantage is unknown', () => {
    const loopback = makeEvidence({ clientRttSamples: [3, 3, 2, 4, 3] });
    const verdict = analyse(loopback);

    expect(verdict.vantages.userConnection.status).toBe('unknown');
    expect(verdict.plain).not.toMatch(/round trip/i);
    expect(verdict.plain).not.toMatch(/\b[0-9]+ ms\b.*your (own )?connection/i);
  });

  /**
   * The loopback guard cannot rest on a latency threshold alone.
   *
   * This is the Phase 1 false accusation arriving through a door the threshold
   * cannot watch. WebKit measured 15 ms to 127.0.0.1 on an ordinary developer
   * machine — above LOCAL_CONTROL_RTT_MS — so the heuristic stayed quiet and the
   * report said "Your connection: Healthy (15 ms round trip)" about a loopback
   * interface. Found by the browser suite, not by any unit test, because no unit
   * test had a reason to imagine a slow loopback.
   */
  it('refuses to judge a local control endpoint however slowly it answers', () => {
    const verdict = analyse(scenarios.slowLoopback());

    expect(verdict.vantages.userConnection.status).toBe('unknown');
    expect(verdict.vantages.userConnection.summary).toMatch(/not measured/i);
    expect(verdict.vantages.networkPath.status).toBe('unknown');

    // The number itself must not appear anywhere a reader would take as a claim.
    expect(verdict.plain).not.toMatch(/15 ms/);
    expect(verdict.headline).not.toMatch(/15 ms/);
    for (const finding of verdict.findings) {
      expect(finding.code).not.toMatch(/^client-/);
    }
  });

  /**
   * The fact wins over the inference, not the other way round.
   *
   * A control endpoint reached through a local proxy can be slow, and a genuine
   * internet endpoint can be fast. Only one of those two signals is a fact.
   */
  it('treats a fast round trip to a real endpoint as measured', () => {
    const verdict = analyse(
      makeEvidence({ clientRttSamples: [9, 10, 9, 11, 9], controlIsLocal: false }),
    );

    expect(verdict.vantages.userConnection.status).not.toBe('unknown');
  });

  /**
   * CONTROL_URL must not become a way around the loopback rule.
   *
   * The setting exists so a local install can measure a real link. It would be a
   * short step from there to treating any configured endpoint as trustworthy, and
   * the guard has to key off what was actually measured rather than off intent.
   */
  it('still refuses to judge when the configured control endpoint is also local', () => {
    const verdict = analyse(
      makeEvidence({ clientRttSamples: [2, 3, 2], controlOrigin: 'http://localhost:8787' }),
    );

    expect(verdict.vantages.userConnection.status).toBe('unknown');
    expect(verdict.vantages.networkPath.status).toBe('unknown');
    expect(verdict.plain).not.toMatch(/round trip/i);
  });

  /**
   * A figure measured against another machine is a different claim from one
   * measured against the server that ran the probe, and the number alone cannot
   * carry that difference.
   */
  it('names the endpoint when the baseline came from somewhere else', () => {
    const verdict = analyse(scenarios.remoteControl());

    expect(verdict.vantages.userConnection.status).not.toBe('unknown');
    expect(verdict.vantages.userConnection.summary).toContain('control.example.net');
  });

  it('does not name an endpoint when the baseline was measured here', () => {
    const verdict = analyse(scenarios.healthy());

    expect(verdict.vantages.userConnection.summary).not.toMatch(/ to \S+\./);
  });

  /**
   * The route phase has to account for itself.
   *
   * "Not enough data to judge the route" used to appear in the verdict with
   * nothing in the checks explaining what was missing, because the phase had no
   * checks at all.
   */
  it('explains an unjudgeable route in the checks, not only in the verdict', () => {
    const verdict = analyse(scenarios.localInstall());
    const path = verdict.checks.filter((c) => c.phase === 'path');

    expect(path.length).toBeGreaterThan(0);
    expect(path.every((c) => c.summary.length > 0)).toBe(true);
    // Whatever it says, it must not present a derived figure as an observed one.
    for (const check of path) {
      for (const row of check.evidence) {
        if (row.label === 'Unexplained excess') {
          expect(row.provenance).not.toBe('measured');
        }
      }
    }
  });

  it('never mentions the reader’s connection at all on a server-only run', () => {
    const verdict = analyse(scenarios.serverOnly());

    expect(verdict.vantages.userConnection.status).toBe('unknown');
    // "Your connection tested fine" is exactly the claim that must not appear
    // when nothing about it was measured.
    expect(verdict.plain).not.toMatch(/your connection tested fine/i);
  });

  it.each(ALL_SCENARIOS)('$name: unknown vantages carry no score', ({ build }) => {
    const verdict = analyse(build());

    for (const [key, vantage] of Object.entries(verdict.vantages)) {
      if (vantage.status === 'unknown') {
        expect(vantage.score, `${key} is unknown but carries a score`).toBeNull();
      }
    }
  });
});

describe('the headline agrees with what follows it', () => {
  /**
   * Found by eye in the browser: "example.com is responding well, and nothing is
   * holding it back" printed above a list of five suggestions and a checks summary
   * reading "5 worth attention".
   */
  it('does not claim nothing is holding the site back while listing suggestions', () => {
    const verdict = analyse(scenarios.healthy());

    if (verdict.findings.length > 0) {
      expect(verdict.headline).not.toMatch(/nothing is holding it back/i);
      expect(verdict.headline.toLowerCase()).toContain('healthy');
    } else {
      expect(verdict.plain).toMatch(/nothing that needs fixing/i);
    }
  });

  it('describes an erratic-but-fast site as uneven, never as slow', () => {
    const verdict = analyse(scenarios.unstable());

    if (/responds unevenly/i.test(verdict.headline)) {
      expect(verdict.headline).not.toMatch(/\bis slow\b/i);
    }
  });

  it.each(ALL_SCENARIOS)('$name: headline is a sentence, not a fragment', ({ build }) => {
    const { headline } = analyse(build());
    expect(headline.length).toBeGreaterThan(20);
    expect(headline.trimEnd()).toMatch(/[.!?]$/);
  });
});

describe('register and formatting', () => {
  /**
   * Covers every user-facing string, not just the headline.
   *
   * Checking only `headline` and `plain` let "Responding quickly (49ms to start
   * sending the page)" survive in a vantage tile — the fix had been applied to the
   * narration helper but not to the vantage summaries, and the narrower assertion
   * could not see it.
   */
  it.each(ALL_SCENARIOS)('$name: writes units as "41 ms", not "41ms"', ({ build }) => {
    const verdict = analyse(build());
    const everything = [
      ...layer1and2(verdict),
      ...verdict.checks.flatMap((c) => [c.summary, c.headline ?? '', c.technical]),
    ];

    for (const text of everything) {
      expect(text, text).not.toMatch(/\d\s*ms\b(?<! ms)/);
      // "milliseconds" spelled out repeatedly reads as padding at this register.
      expect(text, text).not.toMatch(/milliseconds/);
    }
  });

  it.each(ALL_SCENARIOS)('$name: leaves no placeholder plurals in any copy', ({ build }) => {
    for (const text of layer1and2(analyse(build()))) {
      expect(text, text).not.toMatch(/\((?:s|es)\)/);
    }
    for (const check of analyse(build()).checks) {
      for (const text of [check.title, check.summary, check.headline ?? '']) {
        expect(text, `${check.id}: ${text}`).not.toMatch(/\((?:s|es)\)/);
      }
    }
  });

  it.each(ALL_SCENARIOS)('$name: avoids banned marketing register', ({ build }) => {
    const banned = /\b(blazing|lightning[- ]fast|supercharge|simply|unfortunately|oops)\b/i;

    for (const text of layer1and2(analyse(build()))) {
      expect(text, text).not.toMatch(banned);
    }
  });

  it.each(ALL_SCENARIOS)('$name: uses no exclamation marks or emoji', ({ build }) => {
    // Status is carried by icon plus word plus colour, deliberately. Emoji in the
    // copy would duplicate that badly and translate poorly.
    for (const text of layer1and2(analyse(build()))) {
      expect(text, text).not.toMatch(/!/);
      expect(text, text).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

describe('every finding names an owner', () => {
  it.each(ALL_SCENARIOS)('$name: no finding is left unattributed', ({ build }) => {
    for (const finding of analyse(build()).findings) {
      // "Enable Brotli" is useless advice to a visitor who does not run the
      // server, so the owner is part of the data model rather than the prose.
      expect(['site-owner', 'you', 'your-isp', 'nobody']).toContain(finding.owner);
    }
  });
});

describe('glossary covers the jargon that reaches Layer 1 and 2', () => {
  /**
   * Terms a non-specialist reader cannot be assumed to know. If one appears in the
   * verdict or a finding's plain-language fields, it needs a glossary entry — which
   * is what the UI turns into a tooltip.
   */
  const NEEDS_DEFINING = [
    'TTFB',
    'ALPN',
    'OCSP',
    'CNAME',
    'HSTS',
    'CSP',
    'DNSSEC',
    'IQR',
    'ASN',
    'TLS',
  ];

  it.each(ALL_SCENARIOS)('$name: defines any technical term it uses', ({ build }) => {
    const verdict = build();
    const analysed = analyse(verdict);
    const defined = new Set(analysed.glossary.map((g) => g.term.toUpperCase()));
    const prose = layer1and2(analysed).join(' ');

    const undefinedTerms = NEEDS_DEFINING.filter(
      (term) => new RegExp(`\\b${term}\\b`).test(prose) && !defined.has(term.toUpperCase()),
    );

    expect(undefinedTerms).toEqual([]);
  });

  it('gives every glossary entry a real definition', () => {
    for (const entry of analyse(scenarios.slowServer()).glossary) {
      expect(entry.term.length).toBeGreaterThan(1);
      expect(entry.definition.length, entry.term).toBeGreaterThan(20);
      expect(entry.definition.trimEnd()).toMatch(/[.!?]$/);
    }
  });
});
