import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ICON_VIEWBOX, ICONS } from './generated.js';

/**
 * Guards every icon reference in the library.
 *
 * The important thing this exists for: `html`<dwc-icon name="chevron">`` is a
 * template attribute, and TypeScript does not typecheck the contents of a Lit
 * template. Typing the property as `IconName` therefore proves nothing about the
 * call sites — a renamed or misspelled icon compiles cleanly and silently falls
 * back to the placeholder at runtime, which is very easy to miss in review.
 *
 * The component keeps that fallback on purpose (an invisible icon is harder to
 * notice than a slightly wrong one), so this is the check that turns a silent
 * substitution into a failed build.
 */

const componentsDir = fileURLToPath(new URL('../components/', import.meta.url));

const sources = readdirSync(componentsDir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((file) => ({ file, text: readFileSync(componentsDir + file, 'utf8') }));

/** Static `name="..."` values on a dwc-icon element. */
function staticIconNames(text: string): string[] {
  return [...text.matchAll(/<dwc-icon\b[^>]*?\sname="([^"]+)"/g)].map((m) => m[1]!);
}

/** `name=${...}` bindings, which cannot be checked statically. */
function dynamicIconBindings(text: string): number {
  return [...text.matchAll(/<dwc-icon\b[^>]*?\sname=\$\{/g)].length;
}

describe('the icon registry', () => {
  it('generated something', () => {
    expect(Object.keys(ICONS).length).toBeGreaterThan(30);
  });

  it('uses Phosphor’s 256-unit grid', () => {
    // The component's viewBox comes from here; a silent change upstream would
    // render every glyph at the wrong scale.
    expect(ICON_VIEWBOX).toBe('0 0 256 256');
  });

  it('gives every icon a regular weight to fall back to', () => {
    for (const [name, weights] of Object.entries(ICONS)) {
      expect(weights, `${name} has no regular weight`).toHaveProperty('regular');
    }
  });

  it('gives every duotone weight both a front and a rear layer', () => {
    for (const [name, weights] of Object.entries(ICONS)) {
      const duotone = (weights as Record<string, { front: string; back?: string }>)['duotone'];
      if (duotone === undefined) continue;
      expect(duotone.front.length, `${name} duotone front`).toBeGreaterThan(0);
      expect(duotone.back, `${name} duotone rear layer`).toBeDefined();
    }
  });

  it('emits path data only, with no stroke or opacity attributes left in', () => {
    for (const [name, weights] of Object.entries(ICONS)) {
      for (const [weight, geometry] of Object.entries(
        weights as Record<string, { front: string; back?: string }>,
      )) {
        // Codegen extracts the `d` attribute alone. Anything else here would mean
        // the parser let markup through into what the component treats as a path.
        expect(geometry.front, `${name}/${weight}`).not.toMatch(/[<>"]/);
        if (geometry.back !== undefined) {
          expect(geometry.back, `${name}/${weight} rear`).not.toMatch(/[<>"]/);
        }
      }
    }
  });
});

describe('every icon referenced by a component exists', () => {
  it('resolves all static name attributes', () => {
    const unknown: string[] = [];

    for (const { file, text } of sources) {
      for (const name of staticIconNames(text)) {
        if (!(name in ICONS)) unknown.push(`${file}: name="${name}"`);
      }
    }

    expect(unknown).toEqual([]);
  });

  it('finds icon usages at all, so the scan cannot pass vacuously', () => {
    const total = sources.reduce((n, s) => n + staticIconNames(s.text).length, 0);
    expect(total).toBeGreaterThan(5);
  });

  /**
   * Dynamic bindings are legitimate — the verdict banner and check rows pick an
   * icon from data — but they are outside this guard. Each one needs its own
   * mapping covered by that component's tests, so this records how many exist
   * rather than pretending they are verified.
   */
  it('documents how many icon names are chosen dynamically', () => {
    const dynamic = sources.reduce((n, s) => n + dynamicIconBindings(s.text), 0);
    expect(dynamic).toBeGreaterThanOrEqual(0);
  });
});
