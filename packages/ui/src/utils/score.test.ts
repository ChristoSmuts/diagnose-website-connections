import { describe, expect, it } from 'vitest';
import { SCORE_BANDS, scoreTone, verdictTone } from './score.js';

describe('scoreTone', () => {
  it.each([
    [100, 'ok'],
    [80, 'ok'],
    [79, 'warn'],
    [61, 'warn'],
    [50, 'warn'],
    [49, 'bad'],
    [0, 'bad'],
  ])('%i is %s', (score, tone) => {
    expect(scoreTone(score)).toBe(tone);
  });

  it('treats an absent score as unknown rather than healthy', () => {
    expect(scoreTone(null)).toBe('unknown');
    expect(scoreTone(Number.NaN)).toBe('unknown');
  });

  it('puts the band edges exactly where the constants say', () => {
    expect(scoreTone(SCORE_BANDS.ok)).toBe('ok');
    expect(scoreTone(SCORE_BANDS.ok - 1)).toBe('warn');
    expect(scoreTone(SCORE_BANDS.warn)).toBe('warn');
    expect(scoreTone(SCORE_BANDS.warn - 1)).toBe('bad');
  });
});

describe('verdictTone', () => {
  /**
   * The regression this exists for.
   *
   * The banner took its colour from the culprit alone, so 89 and 61 both rendered
   * flatly red — and the 89 sat beside a dial the same component had coloured
   * green. Amber was unreachable at the top of the report.
   */
  it('separates a high-scoring problem from a low-scoring one', () => {
    expect(verdictTone(89, 'blamed')).toBe('warn');
    expect(verdictTone(35, 'blamed')).toBe('bad');
  });

  /**
   * A verdict that names someone to blame never renders green, however well it
   * scored. "The website owner needs to fix this" on a healthy green wash is a
   * contradiction, and readers resolve those by believing the colour.
   */
  it('never shows green when there is a culprit', () => {
    expect(verdictTone(96, 'blamed')).toBe('warn');
    expect(verdictTone(100, 'blamed')).toBe('warn');
  });

  /**
   * "Not enough information" must not borrow a severity from a number it does not
   * really stand behind. Amber there reads as a mild warning about the site rather
   * than an admission about the evidence, which is the opposite of what it means.
   */
  it('keeps an inconclusive verdict neutral, whatever it scored', () => {
    expect(verdictTone(50, 'unknown')).toBe('unknown');
    expect(verdictTone(96, 'unknown')).toBe('unknown');
    expect(verdictTone(10, 'unknown')).toBe('unknown');
  });

  it('leaves a blameless verdict to its score', () => {
    expect(verdictTone(96, 'score')).toBe('ok');
    expect(verdictTone(61, 'score')).toBe('warn');
    expect(verdictTone(null, 'score')).toBe('unknown');
  });

  /** Unreachable scores 0 and has a culprit; it must stay red, not soften. */
  it('keeps a total failure red', () => {
    expect(verdictTone(0, 'blamed')).toBe('bad');
  });
});
