import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the one structural hazard in the token sheet.
 *
 * The dark palette has to be written twice — once inside
 * `@media (prefers-color-scheme: dark)` for "follow my OS", and once under
 * `:root[data-theme='dark']` so an explicit toggle beats the OS. CSS gives no way
 * to share them: a media query cannot be re-targeted at an attribute selector,
 * and `@custom-media` is not available.
 *
 * The failure that follows is nasty precisely because it is invisible on one code
 * path. Add a token to only one block and the app looks correct while following
 * the system theme, then renders an unstyled or wrong-coloured element the moment
 * someone uses the toggle — or the reverse. Nobody notices until a user does.
 *
 * So: assert the copies agree, and that neither invents a property the light
 * default has never heard of.
 */

const RAW = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8');

/**
 * Comments are stripped before any structural parsing.
 *
 * Not cosmetic: the header comment documents the three theme states and so
 * literally contains the string `:root[data-theme='dark']`. Searching the raw
 * text found that prose first and parsed the following `@font-face` block as the
 * dark palette — which then compared as empty and passed nothing useful.
 */
const CSS = RAW.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Extracts the declaration block that follows a selector.
 *
 * Brace-matched rather than regexed to the next `}`, because these blocks contain
 * nested constructs and a lazy match would stop at the first inner brace.
 */
function blockAfter(css: string, selector: string): string {
  // The opening brace is matched as part of the selector pattern rather than
  // searched for afterwards. Searching for the next `{` from the end of the
  // selector string skips the brace that belongs to it and locks onto the
  // following rule — which silently parsed the dark media query as `:root`.
  const bare = selector.replace(/\s*\{\s*$/, '');
  const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{`).exec(css);
  if (match === null) throw new Error(`Selector not found in tokens.css: ${bare}`);

  const open = match.index + match[0].length - 1;

  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`Unbalanced braces after: ${selector}`);
}

/** Custom-property names declared in a block. */
function customProperties(block: string): Set<string> {
  const names = new Set<string>();
  for (const match of block.matchAll(/(--[\w-]+)\s*:/g)) {
    names.add(match[1]!);
  }
  return names;
}

const lightRoot = customProperties(blockAfter(CSS, ':root {'));
const systemDark = customProperties(blockAfter(CSS, ":root:not([data-theme='light'])"));
const explicitDark = customProperties(blockAfter(CSS, ":root[data-theme='dark']"));

const sorted = (s: Set<string>): string[] => [...s].sort();

describe('token sheet structure', () => {
  it('declares a substantial set of tokens on the light default', () => {
    // Sanity check on the parser itself: if this collapses to near-zero, the
    // comparisons below would pass vacuously and guard nothing.
    expect(lightRoot.size).toBeGreaterThan(60);
  });

  it('defines all three theme states', () => {
    expect(systemDark.size).toBeGreaterThan(20);
    expect(explicitDark.size).toBeGreaterThan(20);
  });
});

describe('the two dark blocks must not drift apart', () => {
  it('declares an identical set of properties in both', () => {
    expect(sorted(systemDark)).toEqual(sorted(explicitDark));
  });

  it('overrides nothing that the light default does not define', () => {
    // A property that exists only in a dark block has no light value to fall back
    // to, so it renders as an invalid/empty value in light mode.
    const orphans = [...systemDark, ...explicitDark].filter((p) => !lightRoot.has(p));
    expect(sorted(new Set(orphans))).toEqual([]);
  });
});

describe('theming rules that must not be broken', () => {
  /**
   * Writing `:root[data-theme='dark']` without the `:not([data-theme='light'])`
   * guard on the media query lets the OS preference win over an explicit light
   * choice, which silently breaks the toggle in one direction only.
   */
  it('guards the system-preference block against an explicit light choice', () => {
    expect(CSS).toMatch(
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\)/,
    );
  });

  it('disables motion durations under prefers-reduced-motion', () => {
    const block = blockAfter(CSS, '@media (prefers-reduced-motion: reduce)');
    // Handled globally rather than per component, so no animation can escape it.
    for (const token of ['--dwc-duration-fast', '--dwc-duration', '--dwc-duration-slow']) {
      expect(block).toContain(token);
    }
  });

  it('self-hosts every font rather than fetching one from a CDN', () => {
    // The offline / self-hosted guarantee: no external origin in any url().
    for (const match of CSS.matchAll(/url\(([^)]+)\)/g)) {
      expect(match[1]).not.toMatch(/^['"]?(https?:)?\/\//);
    }
    expect(CSS).toContain("format('woff2-variations')");
  });
});
