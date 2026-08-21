import type { StatusTone } from '@dwc/tokens';

/**
 * The score bands, in one place, because two components render the same number.
 *
 * The dial had these thresholds inline and the verdict banner took its colour
 * from the culprit instead, so a site scoring 89 rendered a green dial inside a
 * red banner. Layer 1 is meant to be read as one object; two halves of it
 * disagreeing about how bad the news is undermines both.
 */
export const SCORE_BANDS = {
  /** At or above this, nothing is materially wrong. */
  ok: 80,
  /** At or above this, there is a problem worth attention but not alarm. */
  warn: 50,
} as const;

/** Which tone a 0-100 score belongs to. Null (not scored) is never "ok". */
export function scoreTone(score: number | null): StatusTone {
  if (score === null || Number.isNaN(score)) return 'unknown';
  if (score >= SCORE_BANDS.ok) return 'ok';
  if (score >= SCORE_BANDS.warn) return 'warn';
  return 'bad';
}

/**
 * How a verdict turns its score into a colour.
 *
 * Three modes rather than a flag, because "nobody is to blame" covers two
 * opposite situations: a healthy site, and one we could not form an opinion
 * about. Collapsing them tinted "Not enough information" amber, which reads as a
 * mild warning about the site rather than an admission about the evidence.
 */
export type ToneMode =
  /** Blameless and measured — the score speaks for itself. */
  | 'score'
  /** Someone is named as the cause; never render this green. */
  | 'blamed'
  /** No conclusion was reached, so no severity may be implied. */
  | 'unknown';

/**
 * The tone for a verdict, given how bad it is and what kind of verdict it is.
 *
 * The severity comes from the score, so amber is reachable rather than the banner
 * being red or green and nothing else. But a verdict that names a culprit never
 * renders green however high it scored: "the website owner needs to fix this" set
 * against a healthy green wash is a contradiction, and a reader resolves those by
 * trusting the colour and skipping the words.
 */
export function verdictTone(score: number | null, mode: ToneMode): StatusTone {
  if (mode === 'unknown') return 'unknown';
  const tone = scoreTone(score);
  if (mode === 'score') return tone;
  return tone === 'ok' ? 'warn' : tone;
}
