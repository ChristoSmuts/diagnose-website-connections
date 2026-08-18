import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The CLI prints user-facing copy, and nothing was checking it either.
 *
 * `copy.test.ts` in the engine only ever sees strings the engine produces, and
 * `progress-copy.test.ts` next door scans the probe's progress messages. The CLI
 * summary fell between the two and drifted: it defined its own duration helper
 * that emitted `73ms`, breaking the spaced-unit rule the whole report follows.
 * That is the third time the same fault has reached a surface with no test on it.
 *
 * Scanning the source rather than running the CLI is deliberate: a real run needs
 * the live internet, which is what a unit test must not depend on.
 */
const SOURCE = readFileSync(fileURLToPath(new URL('./probe.ts', import.meta.url)), 'utf8');

/**
 * Comments are stripped before the literals are read.
 *
 * Not optional tidiness: an apostrophe in prose ("the engine's own formatter")
 * opens a single-quoted string as far as the matcher is concerned, which then
 * runs on until the next quote and drags a chunk of comment in with it. The first
 * run of this suite failed on a fragment of its own explanatory comment.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Every template and single-quoted string literal in the file. */
const literals = [...CODE.matchAll(/`[^`]*`|'[^']*'/g)].map((m) => m[0].slice(1, -1));

describe('CLI output copy', () => {
  it('finds the strings to check', () => {
    // Guards the parser itself. Without this the suite would check whatever
    // subset the pattern happened to match and still report green.
    expect(literals.length).toBeGreaterThan(20);
    expect(literals.some((l) => l.includes('MEASUREMENTS'))).toBe(true);
    // Comment prose must not survive into the literal list.
    expect(literals.filter((l) => l.includes('spaced-unit rule'))).toEqual([]);
  });

  /**
   * The specific fix, asserted structurally rather than by pattern.
   *
   * Reusing the engine's formatter is what stops this drifting again — a local
   * copy is free to be wrong, and was.
   */
  it('formats durations with the engine helper rather than its own', () => {
    expect(SOURCE).toMatch(/import \{[^}]*\bms as duration\b[^}]*\} from '@dwc\/diagnostics'/);
    expect(SOURCE).not.toMatch(/\$\{String\(Math\.round\([^)]*\)\)\}ms/);
  });

  it.each(literals)('writes units as "41 ms", not "41ms": %s', (literal) => {
    expect(literal).not.toMatch(/\d\s*ms\b(?<! ms)/);
    expect(literal).not.toMatch(/\}(ms|kb|mb)\b/i);
  });

  it.each(literals)('pluralises properly rather than "address(es)": %s', (literal) => {
    expect(literal).not.toMatch(/\(e?s\)/i);
  });

  it.each(literals)('stays in register: %s', (literal) => {
    expect(literal).not.toMatch(/\b(blazing|lightning|supercharge|simply|unfortunately|oops)\b/i);
    expect(literal).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
