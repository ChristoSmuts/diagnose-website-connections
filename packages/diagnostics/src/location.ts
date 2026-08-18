/**
 * Where the thing we connected to appears to be.
 *
 * This module exists to answer one question and to refuse a second one. It can
 * say something about the location of the infrastructure that answered our
 * request. It cannot say where a business stores, processes or backs up data —
 * that is a contractual and legal fact, invisible to a network probe. An edge in
 * Johannesburg routinely fronts an origin in Virginia keeping its database in
 * Ireland, and all three are ordinary. Every consumer of this module has to carry
 * that limit into its copy rather than leaving the reader to infer it.
 *
 * Pure, like the rest of the engine: no I/O, no clock, no randomness. Everything
 * here is derived from evidence already collected.
 */

import type { AddressEvidence, HttpEvidence, NetworkIdentity } from '@dwc/contracts';
import { countryLabel } from './countries.js';

// ---------------------------------------------------------------------------
// Points of presence
// ---------------------------------------------------------------------------

/**
 * Airport codes used by the large CDNs for their edge locations.
 *
 * Deliberately partial. A code that is not here is reported verbatim rather than
 * guessed at — "CPT" tells a reader more than a wrong city does, and a wrong city
 * beside a hosting question is exactly the sort of confident error this report
 * exists not to make.
 */
const POPS: Record<string, readonly [city: string, country: string]> = {
  AKL: ['Auckland', 'NZ'],
  AMS: ['Amsterdam', 'NL'],
  ARN: ['Stockholm', 'SE'],
  ATL: ['Atlanta', 'US'],
  BAH: ['Manama', 'BH'],
  BCN: ['Barcelona', 'ES'],
  BLR: ['Bengaluru', 'IN'],
  BOM: ['Mumbai', 'IN'],
  BOS: ['Boston', 'US'],
  BRU: ['Brussels', 'BE'],
  BUD: ['Budapest', 'HU'],
  CAI: ['Cairo', 'EG'],
  CDG: ['Paris', 'FR'],
  CGK: ['Jakarta', 'ID'],
  CMH: ['Columbus', 'US'],
  CPH: ['Copenhagen', 'DK'],
  CPT: ['Cape Town', 'ZA'],
  DEL: ['New Delhi', 'IN'],
  DEN: ['Denver', 'US'],
  DFW: ['Dallas', 'US'],
  DOH: ['Doha', 'QA'],
  DUB: ['Dublin', 'IE'],
  DUS: ['Düsseldorf', 'DE'],
  DXB: ['Dubai', 'AE'],
  EWR: ['Newark', 'US'],
  EZE: ['Buenos Aires', 'AR'],
  FCO: ['Rome', 'IT'],
  FRA: ['Frankfurt', 'DE'],
  GIG: ['Rio de Janeiro', 'BR'],
  GRU: ['São Paulo', 'BR'],
  HAM: ['Hamburg', 'DE'],
  HEL: ['Helsinki', 'FI'],
  HKG: ['Hong Kong', 'HK'],
  HYD: ['Hyderabad', 'IN'],
  IAD: ['Ashburn', 'US'],
  ICN: ['Seoul', 'KR'],
  IST: ['Istanbul', 'TR'],
  JFK: ['New York', 'US'],
  JNB: ['Johannesburg', 'ZA'],
  KIX: ['Osaka', 'JP'],
  LAS: ['Las Vegas', 'US'],
  LAX: ['Los Angeles', 'US'],
  LHR: ['London', 'GB'],
  LIM: ['Lima', 'PE'],
  LIS: ['Lisbon', 'PT'],
  LOS: ['Lagos', 'NG'],
  MAA: ['Chennai', 'IN'],
  MAD: ['Madrid', 'ES'],
  MAN: ['Manchester', 'GB'],
  MCT: ['Muscat', 'OM'],
  MEL: ['Melbourne', 'AU'],
  MEX: ['Mexico City', 'MX'],
  MIA: ['Miami', 'US'],
  MRS: ['Marseille', 'FR'],
  MSP: ['Minneapolis', 'US'],
  MUC: ['Munich', 'DE'],
  MXP: ['Milan', 'IT'],
  NBO: ['Nairobi', 'KE'],
  NRT: ['Tokyo', 'JP'],
  ORD: ['Chicago', 'US'],
  OSL: ['Oslo', 'NO'],
  OTP: ['Bucharest', 'RO'],
  PDX: ['Portland', 'US'],
  PER: ['Perth', 'AU'],
  PHX: ['Phoenix', 'US'],
  PRG: ['Prague', 'CZ'],
  SCL: ['Santiago', 'CL'],
  SEA: ['Seattle', 'US'],
  SFO: ['San Francisco', 'US'],
  SIN: ['Singapore', 'SG'],
  SJC: ['San Jose', 'US'],
  SOF: ['Sofia', 'BG'],
  SYD: ['Sydney', 'AU'],
  TLV: ['Tel Aviv', 'IL'],
  TPE: ['Taipei', 'TW'],
  VIE: ['Vienna', 'AT'],
  WAW: ['Warsaw', 'PL'],
  YUL: ['Montréal', 'CA'],
  YVR: ['Vancouver', 'CA'],
  YYZ: ['Toronto', 'CA'],
  ZRH: ['Zürich', 'CH'],
};

/** An edge location claimed by a response header. */
export interface PopSignal {
  /** The airport code exactly as the header gave it. */
  code: string;
  /** "Cape Town, South Africa (ZA)", or null when the code is not in the table. */
  place: string | null;
  /** "Cape Town, ZA" — the same fact, short enough for a collapsed row. */
  short: string | null;
  /** Two-letter country, when known. Feeds the agreement check. */
  country: string | null;
  /** The header it came from, so the evidence row can say where it got this. */
  source: string;
}

function place(code: string): Pick<PopSignal, 'place' | 'short' | 'country'> {
  const entry = POPS[code];
  if (entry === undefined) return { place: null, short: null, country: null };
  const [city, country] = entry;
  return {
    place: `${city}, ${countryLabel(country) ?? country}`,
    short: `${city}, ${country}`,
    country,
  };
}

/**
 * Edge locations advertised in the response headers.
 *
 * Every one of these is a vendor convention rather than a standard, so each
 * pattern is matched strictly and a value that does not fit is ignored rather
 * than salvaged. `x-served-by` is the cautionary case: Fastly writes
 * `cache-cpt13824-CPT` there, but the header is not reserved and a real site was
 * observed sending `marketing-site` — a loose match would have read that as an
 * airport code and confidently named the wrong continent.
 *
 * Every match is returned rather than the first, because two headers disagreeing
 * is information and picking a winner would hide it.
 */
export function detectPops(headers: Record<string, string>): PopSignal[] {
  const found: PopSignal[] = [];
  const get = (name: string): string => headers[name]?.trim() ?? '';

  // Cloudflare: "a2d1207049284193-CPT"
  const cfRay = /-([A-Z]{3})$/.exec(get('cf-ray'));
  if (cfRay?.[1] !== undefined) {
    found.push({ code: cfRay[1], source: 'cf-ray', ...place(cfRay[1]) });
  }

  // CloudFront: "JNB51-P2"
  const amz = /^([A-Z]{3})\d/.exec(get('x-amz-cf-pop'));
  if (amz?.[1] !== undefined) {
    found.push({ code: amz[1], source: 'x-amz-cf-pop', ...place(amz[1]) });
  }

  // Fastly: "cache-cpt13824-CPT". The cache- prefix is what makes this safe.
  const fastly = /^cache-[a-z]+\d+-([A-Z]{3})$/.exec(get('x-served-by'));
  if (fastly?.[1] !== undefined) {
    found.push({ code: fastly[1], source: 'x-served-by', ...place(fastly[1]) });
  }

  // Fly.io: "jnb"
  const fly = /^([a-z]{3})$/.exec(get('fly-region'));
  if (fly?.[1] !== undefined) {
    const code = fly[1].toUpperCase();
    found.push({ code, source: 'fly-region', ...place(code) });
  }

  // Vercel: "cpt1::abcde-1700000000000-0123456789ab"
  const vercel = /^([a-z]{3})\d/.exec(get('x-vercel-id'));
  if (vercel?.[1] !== undefined) {
    const code = vercel[1].toUpperCase();
    found.push({ code, source: 'x-vercel-id', ...place(code) });
  }

  return found;
}

// ---------------------------------------------------------------------------
// Cloud regions in reverse DNS
// ---------------------------------------------------------------------------

/**
 * Cloud region identifiers, which unlike airport codes in hostnames are
 * unambiguous — `af-south-1` means one thing and cannot mean anything else.
 *
 * Only these are read out of a reverse-DNS name. Hosting providers embed all
 * sorts of abbreviations, and Wikimedia's `text-lb.drmrs.wikimedia.org` shows why
 * guessing is a bad idea: `drmrs` is Marseille, but only to somebody who already
 * knows. The full name is always shown so a reader who does know can use it; only
 * the unambiguous part is turned into a claim.
 */
const REGION_PATTERN =
  /\b((?:af|ap|ca|eu|il|me|mx|sa|us)-(?:north|south|east|west|central|northeast|northwest|southeast|southwest)-?\d)\b/;

const REGIONS: Record<string, readonly [name: string, country: string]> = {
  'af-south-1': ['Cape Town', 'ZA'],
  'africa-south1': ['Johannesburg', 'ZA'],
  'ap-east-1': ['Hong Kong', 'HK'],
  'ap-northeast-1': ['Tokyo', 'JP'],
  'ap-northeast-2': ['Seoul', 'KR'],
  'ap-northeast-3': ['Osaka', 'JP'],
  'ap-south-1': ['Mumbai', 'IN'],
  'ap-south-2': ['Hyderabad', 'IN'],
  'ap-southeast-1': ['Singapore', 'SG'],
  'ap-southeast-2': ['Sydney', 'AU'],
  'ap-southeast-3': ['Jakarta', 'ID'],
  'ap-southeast-4': ['Melbourne', 'AU'],
  'ca-central-1': ['Montréal', 'CA'],
  'eu-central-1': ['Frankfurt', 'DE'],
  'eu-central-2': ['Zürich', 'CH'],
  'eu-north-1': ['Stockholm', 'SE'],
  'eu-south-1': ['Milan', 'IT'],
  'eu-south-2': ['Madrid', 'ES'],
  'eu-west-1': ['Ireland', 'IE'],
  'eu-west-2': ['London', 'GB'],
  'eu-west-3': ['Paris', 'FR'],
  'europe-west1': ['Belgium', 'BE'],
  'europe-west2': ['London', 'GB'],
  'il-central-1': ['Tel Aviv', 'IL'],
  'me-central-1': ['Dubai', 'AE'],
  'me-south-1': ['Manama', 'BH'],
  'mx-central-1': ['Querétaro', 'MX'],
  'sa-east-1': ['São Paulo', 'BR'],
  'us-central1': ['Iowa', 'US'],
  'us-east-1': ['Virginia', 'US'],
  'us-east-2': ['Ohio', 'US'],
  'us-west-1': ['California', 'US'],
  'us-west-2': ['Oregon', 'US'],
};

export interface RegionSignal {
  token: string;
  place: string;
  short: string;
  country: string;
}

/** The cloud region named in a reverse-DNS entry, when there is one. */
export function regionFromPtr(ptr: string | null): RegionSignal | null {
  if (ptr === null) return null;
  const match = REGION_PATTERN.exec(ptr.toLowerCase());
  const token = match?.[1];
  if (token === undefined) return null;
  const entry = REGIONS[token];
  if (entry === undefined) return null;
  const [name, country] = entry;
  return {
    token,
    place: `${name}, ${countryLabel(country) ?? country}`,
    short: `${name}, ${country}`,
    country,
  };
}

// ---------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------

/**
 * Kilometres a signal covers per millisecond of measured round trip.
 *
 * Light in glass runs at roughly two thirds of its speed in vacuum, so about
 * 200 km per millisecond of travel — and a round trip covers the distance twice,
 * which halves it to 100 km per millisecond measured.
 */
export const KM_PER_MS = 100;

/**
 * The furthest apart two points on Earth can be, near enough.
 *
 * Half the circumference. A ceiling above this excludes nowhere, and printing it
 * anyway would dress up an absence of information as a measurement — "within
 * 30,400 km" reads like a finding and rules out precisely nothing.
 */
export const MAX_TERRESTRIAL_KM = 20_000;

/**
 * The furthest away something answering in this many milliseconds can be.
 *
 * A ceiling and nothing else. Real paths bend, queue, and wait on the far end,
 * and every one of those only adds time — so the true distance is always less
 * than this, never more. That asymmetry is what makes the number worth
 * reporting: it can prove a server is *not* on another continent, and it can
 * never say where it is.
 *
 * Rounded down to a round hundred, so it reads as the estimate it is rather than
 * implying a precision the method does not have.
 *
 * Null when the round trip is too slow to exclude anywhere on the planet. That is
 * a different fact from "we did not measure", and callers must say so.
 */
export function distanceCeilingKm(rttMs: number): number | null {
  if (!Number.isFinite(rttMs) || rttMs <= 0) return null;
  const km = Math.max(100, Math.floor((rttMs * KM_PER_MS) / 100) * 100);
  return km > MAX_TERRESTRIAL_KM ? null : km;
}

// ---------------------------------------------------------------------------
// Agreement between independent claims
// ---------------------------------------------------------------------------

export interface CountryClaim {
  country: string;
  label: string;
  /** What told us — named in the evidence row so an inference stays traceable. */
  source: string;
}

/**
 * Every independent claim about which country this site is served from.
 *
 * These come from genuinely separate systems — a routing registry, a certificate
 * authority, a CDN's own header — and they are collected rather than reconciled.
 * Where they disagree, the disagreement is the point: a prefix registered in the
 * United States serving from an edge in Cape Town is not an error in either
 * record, it is what anycast looks like from the outside.
 */
export function countryClaims(input: {
  network: NetworkIdentity;
  pops: readonly PopSignal[];
  regions: readonly RegionSignal[];
  certCountry: string | null;
}): CountryClaim[] {
  const claims: CountryClaim[] = [];
  const add = (country: string | null, source: string): void => {
    const code = country?.trim().toUpperCase() ?? '';
    if (code.length === 0) return;
    claims.push({ country: code, label: countryLabel(code) ?? code, source });
  };

  add(input.network.country, 'routing registry, for the announced prefix');
  add(input.network.asnCountry, 'routing registry, for the network operator');
  for (const pop of input.pops) add(pop.country, `edge location in ${pop.source}`);
  for (const region of input.regions) add(region.country, 'cloud region in reverse DNS');
  add(input.certCountry, 'certificate subject');

  return claims;
}

/** The distinct countries claimed, in the order first seen. */
export function distinctCountries(claims: readonly CountryClaim[]): string[] {
  return [...new Set(claims.map((c) => c.country))];
}

// ---------------------------------------------------------------------------
// The whole picture
// ---------------------------------------------------------------------------

export interface HostingLocation {
  pops: PopSignal[];
  regions: RegionSignal[];
  claims: CountryClaim[];
  countries: string[];
  /** True when connections terminate at a CDN edge, which hides the origin. */
  behindEdge: boolean;
  /** Reverse DNS per address, kept whole because what we cannot parse still reads. */
  reverseNames: { address: string; ptr: string }[];
}

export function describeLocation(input: {
  network: NetworkIdentity;
  addresses: readonly AddressEvidence[];
  http: HttpEvidence | null;
  certCountry: string | null;
}): HostingLocation {
  const pops = detectPops(input.http?.headers ?? {});

  const regions: RegionSignal[] = [];
  const reverseNames: { address: string; ptr: string }[] = [];
  for (const address of input.addresses) {
    if (address.ptr === null) continue;
    reverseNames.push({ address: address.address, ptr: address.ptr });
    const region = regionFromPtr(address.ptr);
    if (region !== null && !regions.some((r) => r.token === region.token)) regions.push(region);
  }

  const claims = countryClaims({
    network: input.network,
    pops,
    regions,
    certCountry: input.certCountry,
  });

  return {
    pops,
    regions,
    claims,
    countries: distinctCountries(claims),
    behindEdge: input.network.cdnDetected !== null,
    reverseNames,
  };
}
