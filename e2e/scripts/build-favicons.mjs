/**
 * Rasterises apps/web/public/favicon.svg into the formats that cannot read SVG.
 *
 *   pnpm --filter @dwc/e2e run favicons
 *
 * Run by hand, not by the build — the output is committed. A build step would
 * make everyone install a browser to regenerate two files that change about once
 * a year, and nothing here should need a browser to produce a bundle.
 *
 * It lives in the E2E package rather than beside the app because that is where
 * Playwright already is. Adding it to apps/web would pull a browser download
 * into the web app's dependency tree for a once-a-year script.
 *
 * Nothing is fetched from a network: the SVG is read from disk and screenshotted.
 */
import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const publicDir = fileURLToPath(new URL('../../apps/web/public/', import.meta.url));
const svg = readFileSync(`${publicDir}favicon.svg`, 'utf8');

/**
 * Renders at one size, on an explicit background.
 *
 * `prefers-color-scheme` is forced to light: these files are a static snapshot,
 * so they cannot follow the theme the way the SVG does, and light is the safer
 * of the two against the unknown backgrounds an OS home screen might use.
 */
async function render(browser, size, { opaque }) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  });

  await page.setContent(
    `<!doctype html><meta charset="utf-8">
     <style>
       html,body { margin:0; padding:0; width:${size}px; height:${size}px; }
       body { background:${opaque ? '#f7f8fa' : 'transparent'}; }
       svg { display:block; width:${size}px; height:${size}px; }
     </style>
     ${svg}`,
    { waitUntil: 'load' },
  );

  const png = await page.screenshot({ omitBackground: !opaque, type: 'png' });
  await page.close();
  return png;
}

/**
 * Wraps PNGs in an ICO container.
 *
 * Hand-written because every library that does this would be a dependency added
 * for one file. The format is a 6-byte header, one 16-byte directory entry per
 * image, then the payloads — and a PNG payload is legal in an ICO, which is what
 * makes this tractable.
 */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette size
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const browser = await chromium.launch();
try {
  const apple = await render(browser, 180, { opaque: true });
  writeFileSync(`${publicDir}apple-touch-icon.png`, apple);

  const sizes = [16, 32, 48];
  const images = [];
  for (const size of sizes) {
    images.push({ size, data: await render(browser, size, { opaque: false }) });
  }
  writeFileSync(`${publicDir}favicon.ico`, ico(images));

  console.log(
    `build-favicons: apple-touch-icon.png (180) + favicon.ico (${sizes.join(', ')}) from favicon.svg`,
  );
} finally {
  await browser.close();
}
