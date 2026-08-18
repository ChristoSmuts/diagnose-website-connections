/**
 * Extract only the icons this library actually renders into a generated module.
 *
 * Phosphor ships 1512 icons × 6 weights. Depending on it at runtime would put a
 * third-party package into @dwc/ui's dependency graph, which every downstream
 * consumer of the shared library would then inherit. Instead the package is a
 * devDependency, this script pulls out the path data named in icons.manifest.json
 * at build time, and the output is plain inline SVG — no icon font, no sprite
 * sheet, no network request, and `currentColor` keeps working through shadow DOM.
 *
 * Two things about Phosphor's format that the previous hand-drawn icons did not
 * share, and which the component relies on:
 *
 *  1. The viewBox is `0 0 256 256`, not `0 0 24 24`.
 *  2. Paths are FILLED (`fill="currentColor"`), not stroked. There is no
 *     stroke-width to vary — weight is a different set of path data entirely.
 *
 * Duotone is two paths: a rear one Phosphor ships with a baked `opacity="0.2"`,
 * and a solid front one. That opacity is deliberately stripped here and the rear
 * path returned separately, so the component can colour it independently — which
 * is what lets the hero icon pick up the verdict's own tone instead of a fixed
 * grey.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const require = createRequire(import.meta.url);

const manifest = JSON.parse(readFileSync(join(root, 'icons.manifest.json'), 'utf8'));
const { defaultWeights, icons, extraWeights } = manifest;

/**
 * Resolve one asset through the package's own export map.
 *
 * Phosphor declares every SVG individually (`./assets/<weight>/*.svg`) and does
 * NOT export `./package.json`, so the package root cannot be located that way.
 * Resolving each file through its declared export is both the supported route and
 * self-validating: a name absent upstream fails here with a clear error rather
 * than producing an icon that silently renders nothing.
 *
 * Filename convention: regular is bare, every other weight carries its suffix.
 */
function assetPath(phosphorName, weight) {
  const file = weight === 'regular' ? `${phosphorName}.svg` : `${phosphorName}-${weight}.svg`;
  return require.resolve(`@phosphor-icons/core/assets/${weight}/${file}`);
}

/**
 * Pull the `d` attributes out of an icon file, in document order.
 *
 * A deliberately narrow parser: these are generated, uniformly structured files
 * containing only <path> elements, so a full XML parser would be a dependency
 * bought for nothing. It throws rather than guessing if the shape is unexpected.
 */
function extractPaths(file, id) {
  const svg = readFileSync(file, 'utf8');

  if (!svg.includes('viewBox="0 0 256 256"')) {
    throw new Error(`${id}: unexpected viewBox in ${file}. Phosphor's grid may have changed.`);
  }

  const paths = [...svg.matchAll(/<path\b([^>]*)\/>/g)].map((m) => {
    const attrs = m[1];
    const d = /\sd="([^"]+)"/.exec(attrs);
    if (d === null) throw new Error(`${id}: <path> without a d attribute in ${file}`);
    return { d: d[1], hasOpacity: /\sopacity="/.test(attrs) };
  });

  if (paths.length === 0) throw new Error(`${id}: no <path> found in ${file}`);
  return paths;
}

/**
 * Normalise one weight into { front, back? }.
 *
 * `back` is the rear duotone layer with its baked opacity discarded. Everything
 * else collapses to a single front path — several Phosphor glyphs legitimately
 * use more than one path (a circle plus a mark), so they are concatenated rather
 * than treated as an error.
 */
function normalise(file, id, weight) {
  const paths = extractPaths(file, id);

  if (weight === 'duotone') {
    const back = paths.filter((p) => p.hasOpacity);
    const front = paths.filter((p) => !p.hasOpacity);
    if (back.length === 0 || front.length === 0) {
      throw new Error(
        `${id}: duotone expected both a translucent rear path and a solid front path, ` +
          `got ${String(back.length)} and ${String(front.length)}.`,
      );
    }
    return { front: front.map((p) => p.d).join(' '), back: back.map((p) => p.d).join(' ') };
  }

  return { front: paths.map((p) => p.d).join(' ') };
}

const registry = {};
let files = 0;

for (const [name, phosphorName] of Object.entries(icons)) {
  const weights = new Set(defaultWeights);
  for (const [weight, members] of Object.entries(extraWeights)) {
    // `$`-prefixed keys are documentation, not weights. JSON has no comments, so
    // the manifest carries its rationale inline; without this a comment array
    // would be treated as a weight name the moment a string happened to match.
    if (weight.startsWith('$')) continue;
    if (members.includes(name)) weights.add(weight);
  }

  registry[name] = {};
  for (const weight of weights) {
    registry[name][weight] = normalise(assetPath(phosphorName, weight), name, weight);
    files += 1;
  }
}

const serialise = (value) => JSON.stringify(value);

const body = Object.entries(registry)
  .map(([name, weights]) => {
    const inner = Object.entries(weights)
      .map(([weight, data]) => `    ${weight}: ${serialise(data)},`)
      .join('\n');
    return `  ${JSON.stringify(name)}: {\n${inner}\n  },`;
  })
  .join('\n');

const output = join(root, 'src/icons/generated.ts');
mkdirSync(dirname(output), { recursive: true });

writeFileSync(
  output,
  `// GENERATED by scripts/build-icons.mjs — do not edit.
//
// Phosphor icon path data (MIT, © Phosphor Icons), extracted for only the names
// listed in icons.manifest.json. Edit that file and rebuild to change this one.
//
// All glyphs are on a 256×256 grid and are FILLED, not stroked. \`back\` is the
// rear duotone layer with Phosphor's baked opacity removed so the component can
// recolour it.

/** One weight of one icon. \`back\` is present only for duotone. */
export interface IconGeometry {
  readonly front: string;
  readonly back?: string;
}

export const ICON_VIEWBOX = '0 0 256 256';

export const ICONS = {
${body}
} as const satisfies Record<string, Record<string, IconGeometry>>;

export type IconName = keyof typeof ICONS;
`,
  'utf8',
);

const bytes = readFileSync(output).length;
console.error(
  `build-icons: ${String(Object.keys(registry).length)} icons / ${String(files)} weights → ` +
    `src/icons/generated.ts (${String(Math.round(bytes / 1024))} KB)`,
);
