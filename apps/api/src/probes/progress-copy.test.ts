import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The progress messages are user-facing copy, and nothing was checking them.
 *
 * `packages/diagnostics/src/copy.test.ts` guards the report itself, but it only
 * ever sees strings the engine produces. These live in the API, stream over SSE
 * while the probe runs, and are the first words anyone reads — and they had
 * quietly drifted from the conventions the report follows: "Found 4 address(es)"
 * and "Connected in 15ms" both shipped, and both were found by watching a real
 * run in a container rather than by any test.
 *
 * Scanning the source rather than invoking the probes is deliberate: running them
 * needs the live internet, which is exactly what a unit test must not depend on.
 * Same trick, and the same reason, as `packages/ui/src/icons/icons.test.ts`.
 */

const SOURCE = readFileSync(fileURLToPath(new URL('./run.ts', import.meta.url)), 'utf8');

/**
 * Every message literal in a `report(phase, status, message)` call, grouped by call.
 *
 * Parsed by walking balanced parentheses rather than with one regex, because two
 * calls pass a ternary instead of a bare literal. A regex matching only the simple
 * shape skipped them silently — 17 of 19 calls, all green.
 *
 * Template placeholders are left intact on purpose: `${x}ms` is precisely one of
 * the faults being caught.
 */
function progressMessages(source: string): string[][] {
  const perCall: string[][] = [];

  for (const match of source.matchAll(/\breport\(/g)) {
    let depth = 0;
    let end = match.index;

    for (let i = match.index + match[0].length - 1; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    const args = source.slice(match.index + match[0].length, end);
    const literals = [...args.matchAll(/`[^`]*`|'[^']*'/g)].map((m) => m[0].slice(1, -1));
    // The first two literals are the phase and status enums, not prose.
    perCall.push(literals.slice(2));
  }

  return perCall;
}

const PER_CALL = progressMessages(SOURCE);
const MESSAGES = PER_CALL.flat();

describe('probe progress messages', () => {
  it('finds a message for every call', () => {
    // Guards the parser itself. Without this the suite would check whatever subset
    // the pattern happened to match and still report green.
    expect(PER_CALL.filter((literals) => literals.length === 0)).toEqual([]);
    expect(MESSAGES.length).toBeGreaterThan(15);
  });

  it.each(MESSAGES)('writes units as "41 ms", not "41ms": %s', (message) => {
    // Two shapes of one fault: a literal `15ms`, and an interpolated value with
    // the unit welded onto the closing brace.
    expect(message).not.toMatch(/\d\s*ms\b(?<! ms)/);
    expect(message).not.toMatch(/\}(ms|kb|mb)\b/i);
  });

  it.each(MESSAGES)('pluralises properly rather than "address(es)": %s', (message) => {
    expect(message).not.toMatch(/\(e?s\)/i);
  });

  it.each(MESSAGES)('stays in register: %s', (message) => {
    expect(message).not.toMatch(/\b(blazing|lightning|supercharge|simply|unfortunately|oops)\b/i);
    expect(message).not.toContain('!');
    // Status is carried by phase + word, never by an emoji.
    expect(message).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
