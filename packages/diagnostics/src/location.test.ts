import { describe, expect, it } from 'vitest';
import { buildChecks } from './checks.js';
import { countryLabel, countryName } from './countries.js';
import { detectFindings } from './findings/index.js';
import {
  describeLocation,
  detectPops,
  distanceCeilingKm,
  distinctCountries,
  MAX_TERRESTRIAL_KM,
  regionFromPtr,
} from './location.js';
import { scenarios, makeEvidence } from './testing/fixtures.js';

const headers = (extra: Record<string, string>): Record<string, string> => ({
  server: 'nginx',
  ...extra,
});

describe('edge locations in response headers', () => {
  it('reads the Cloudflare ray identifier', () => {
    const [pop] = detectPops(headers({ 'cf-ray': 'a2d1207049284193-CPT' }));
    expect(pop?.code).toBe('CPT');
    expect(pop?.country).toBe('ZA');
    expect(pop?.place).toBe('Cape Town, South Africa (ZA)');
    expect(pop?.short).toBe('Cape Town, ZA');
    expect(pop?.source).toBe('cf-ray');
  });

  it('reads the CloudFront point of presence', () => {
    const [pop] = detectPops(headers({ 'x-amz-cf-pop': 'JNB51-P2' }));
    expect(pop?.code).toBe('JNB');
    expect(pop?.country).toBe('ZA');
  });

  it('reads the Fastly cache name', () => {
    const [pop] = detectPops(headers({ 'x-served-by': 'cache-cpt13824-CPT' }));
    expect(pop?.code).toBe('CPT');
  });

  /**
   * The header is not reserved, and a real site was observed sending
   * "marketing-site" in it. A looser pattern would have read that as an airport
   * code and named a continent on the strength of it.
   */
  it('ignores an x-served-by that is not a Fastly cache name', () => {
    expect(detectPops(headers({ 'x-served-by': 'marketing-site' }))).toEqual([]);
    expect(detectPops(headers({ 'x-served-by': 'web-01-ABC' }))).toEqual([]);
  });

  it('reports an unknown airport code verbatim rather than guessing', () => {
    const [pop] = detectPops(headers({ 'cf-ray': '1234567890abcdef-ZZZ' }));
    expect(pop?.code).toBe('ZZZ');
    expect(pop?.place).toBeNull();
    expect(pop?.country).toBeNull();
  });

  it('returns every header that claims a location, not just the first', () => {
    const found = detectPops(
      headers({ 'cf-ray': 'abc-LHR', 'x-amz-cf-pop': 'JNB51-P2', 'fly-region': 'ams' }),
    );
    expect(found.map((p) => p.code)).toEqual(['LHR', 'JNB', 'AMS']);
  });

  it('finds nothing in an ordinary response', () => {
    expect(detectPops(headers({}))).toEqual([]);
  });
});

describe('cloud regions in reverse DNS', () => {
  it('reads an unambiguous region identifier', () => {
    const region = regionFromPtr('ec2-13-244-1-1.af-south-1.compute.amazonaws.com');
    expect(region?.token).toBe('af-south-1');
    expect(region?.country).toBe('ZA');
  });

  /**
   * Wikimedia names a host after Marseille as "drmrs", which means nothing to
   * anyone who does not already know. The full name is still shown in the check;
   * it is simply never turned into a claim.
   */
  it('does not guess at a provider abbreviation', () => {
    expect(regionFromPtr('text-lb.drmrs.wikimedia.org')).toBeNull();
    expect(regionFromPtr('news.ycombinator.com')).toBeNull();
  });

  it('has nothing to say about an address with no PTR', () => {
    expect(regionFromPtr(null)).toBeNull();
  });
});

describe('the distance ceiling', () => {
  it('allows about 100 km per millisecond of round trip', () => {
    expect(distanceCeilingKm(14)).toBe(1400);
    expect(distanceCeilingKm(1)).toBe(100);
  });

  /**
   * The two furthest points on Earth are about 20,000 km apart, so a larger
   * ceiling excludes nowhere. Printing "within 30,400 km" would dress an absence
   * of information up as a measurement.
   */
  it('refuses to state a ceiling that rules nothing out', () => {
    expect(distanceCeilingKm(285)).toBeNull();
    expect(distanceCeilingKm(MAX_TERRESTRIAL_KM / 100 + 1)).toBeNull();
  });

  it('has no answer without a round trip', () => {
    expect(distanceCeilingKm(0)).toBeNull();
    expect(distanceCeilingKm(-5)).toBeNull();
    expect(distanceCeilingKm(Number.NaN)).toBeNull();
  });
});

describe('country codes', () => {
  it('expands a code without discarding it', () => {
    expect(countryLabel('ZA')).toBe('South Africa (ZA)');
    expect(countryName('ZA')).toBe('South Africa');
  });

  it('keeps a code it does not recognise', () => {
    expect(countryLabel('XX')).toBe('XX');
  });

  it('has nothing to say about nothing', () => {
    expect(countryLabel(null)).toBeNull();
    expect(countryLabel('')).toBeNull();
  });
});

describe('claims that disagree', () => {
  /**
   * The ordinary anycast case, and the reason claims are collected rather than
   * reconciled: the registry and the edge header are both correct and they name
   * different countries.
   */
  it('keeps both countries when the registry and the edge disagree', () => {
    const evidence = scenarios.anycastEdge();
    const location = describeLocation({
      network: evidence.server.network,
      addresses: evidence.server.addresses,
      http: evidence.server.http,
      certCountry: null,
    });

    expect(location.countries).toContain('US');
    expect(location.countries).toContain('ZA');
    expect(location.behindEdge).toBe(true);
  });

  it('collapses repeated claims of the same country', () => {
    expect(
      distinctCountries([
        { country: 'US', label: 'United States (US)', source: 'a' },
        { country: 'US', label: 'United States (US)', source: 'b' },
        { country: 'ZA', label: 'South Africa (ZA)', source: 'c' },
      ]),
    ).toEqual(['US', 'ZA']);
  });
});

describe('the checks this produces', () => {
  const checksFor = (evidence: ReturnType<typeof makeEvidence>) =>
    buildChecks(evidence, detectFindings(evidence, null));

  const find = (evidence: ReturnType<typeof makeEvidence>, id: string) => {
    const check = checksFor(evidence).find((c) => c.id === id);
    expect(check, `no check with id ${id}`).toBeDefined();
    return check!;
  };

  /**
   * The report said "ASAS13335" for as long as this check existed: the probe
   * stores the canonical "AS13335" and the renderer prefixed it a second time.
   */
  it('does not prefix an autonomous system number twice', () => {
    const check = find(scenarios.healthy(), 'network.ownership');
    expect(check.headline).toBe('AS13335');
    expect(JSON.stringify(check)).not.toContain('ASAS');
  });

  /**
   * These rows once omitted provenance, which defaults to 'measured' — so the
   * literal word "unknown" rendered wearing a measured badge.
   */
  it('never badges an unknown value as measured', () => {
    const evidence = makeEvidence({ cdn: null });
    evidence.server.network = {
      asn: null,
      asnName: null,
      prefix: null,
      country: null,
      asnCountry: null,
      registry: null,
      cdnDetected: null,
    };
    for (const row of find(evidence, 'network.ownership').evidence) {
      expect(row.provenance, `${row.label} = ${row.value}`).toBe('unavailable');
    }
  });

  it('says an edge answered, and that the origin is not visible from here', () => {
    const check = find(scenarios.anycastEdge(), 'network.location');
    expect(check.summary).toMatch(/edge/i);
    expect(check.technical).toMatch(/not visible from outside/i);
  });

  /** The single most important sentence in this feature. */
  it('states plainly that it is not establishing data residency', () => {
    for (const scenario of [
      scenarios.anycastEdge(),
      scenarios.directOrigin(),
      scenarios.healthy(),
    ]) {
      const check = checksFor(scenario).find((c) => c.id === 'network.location');
      expect(check?.technical).toMatch(
        /does not establish data residency|establishes data residency/i,
      );
    }
  });

  it('marks every derived location row as inferred, never measured', () => {
    for (const row of find(scenarios.anycastEdge(), 'network.location').evidence) {
      expect(row.provenance, row.label).not.toBe('measured');
    }
  });

  it('skips certificate identity on a domain-validated certificate', () => {
    const check = find(scenarios.healthy(), 'network.certificate-identity');
    expect(check.status).toBe('skipped');
    expect(check.summary).toMatch(/^Not run: /);
  });

  it('reads the identity from an organisation-validated certificate', () => {
    const check = find(scenarios.organisationCert(), 'network.certificate-identity');
    expect(check.status).toBe('pass');
    expect(check.headline).toBe('Example Holdings (Pty) Ltd');
  });

  /**
   * "We did not look" and "we looked and there was nothing" are different facts,
   * and the report keeps them apart everywhere else too.
   */
  it('separates a missing PTR from a lookup that never ran', () => {
    expect(find(scenarios.healthy(), 'network.reverse-dns').status).toBe('unavailable');
    expect(find(scenarios.directOrigin(), 'network.reverse-dns').status).toBe('pass');
  });

  it('reports no constraint rather than a ceiling that excludes nowhere', () => {
    const check = find(scenarios.distantOrigin(), 'network.distance');
    const browser = check.evidence.find((r) => r.label === 'From your browser');
    expect(browser?.value).toMatch(/no constraint/i);
    expect(browser?.provenance).toBe('unavailable');
  });

  it('bounds the distance when the round trip is short enough to', () => {
    const check = find(scenarios.anycastEdge(), 'network.distance');
    expect(check.status).toBe('pass');
    expect(check.evidence.find((r) => r.label === 'From this instance')?.value).toMatch(/km$/);
  });
});

describe('the distance finding', () => {
  const codes = (evidence: ReturnType<typeof makeEvidence>): string[] =>
    detectFindings(evidence, 0).map((f) => f.code);

  it('fires when the site is far, alone, and the route is fine', () => {
    expect(codes(scenarios.distantOrigin())).toContain('origin-geographically-distant');
  });

  /** A CDN edge near the reader is the competing explanation, and it wins. */
  it('stays quiet when a CDN is in front', () => {
    expect(codes(scenarios.anycastEdge())).not.toContain('origin-geographically-distant');
  });

  it('stays quiet when the site is close', () => {
    expect(codes(scenarios.healthy())).not.toContain('origin-geographically-distant');
  });

  it('blames nobody, because distance is nobody`s fault', () => {
    const found = detectFindings(scenarios.distantOrigin(), 0).find(
      (f) => f.code === 'origin-geographically-distant',
    );
    expect(found?.owner).toBe('nobody');
    expect(found?.severity).toBe('info');
  });
});

describe('the headline never argues with the summary beside it', () => {
  /**
   * Behind a CDN with no edge header to read, the headline used to fall through
   * to the registry country — so "United States (US)" sat on the same row as a
   * summary saying the origin was not visible from here.
   */
  it('states no place when a CDN answered and no edge was named', () => {
    const evidence = makeEvidence({ cdn: 'Cloudflare' });
    const check = buildChecks(evidence, detectFindings(evidence, null)).find(
      (c) => c.id === 'network.location',
    );
    expect(check?.summary).toMatch(/edge/i);
    expect(check?.headline).toBeNull();
  });
});
