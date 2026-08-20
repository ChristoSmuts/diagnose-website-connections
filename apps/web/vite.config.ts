import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

/**
 * Preload the self-hosted fonts.
 *
 * Fonts referenced from CSS are only discovered once the stylesheet has been
 * fetched and parsed, so the first paint uses the fallback and then swaps. A
 * preload link moves that fetch to the start of the page load and makes the swap
 * effectively invisible.
 *
 * It has to be a plugin rather than a hand-written tag in index.html because Vite
 * fingerprints the filenames, so the real URL is not known until the bundle is
 * emitted. Hard-coding an unhashed path would produce a preload that 404s and,
 * worse, a console warning about an unused preload on every load.
 */
function preloadFonts(): Plugin {
  return {
    name: 'dwc-preload-fonts',
    enforce: 'post',
    apply: 'build',
    transformIndexHtml(_html, ctx) {
      const fonts = Object.keys(ctx.bundle ?? {}).filter((f) => f.endsWith('.woff2'));

      return fonts.map((href) => ({
        tag: 'link',
        injectTo: 'head' as const,
        attrs: {
          rel: 'preload',
          href: `/${href}`,
          as: 'font',
          type: 'font/woff2',
          // Required even same-origin: font requests are always CORS-mode, and
          // without this the preloaded file is fetched a second time.
          crossorigin: '',
        },
      }));
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), preloadFonts()],

  server: {
    port: 5173,
    proxy: {
      // Same-origin in dev, so the browser's latency measurements against
      // /api/ping are not distorted by a CORS preflight on every request.
      '/api': {
        target: process.env.API_URL ?? 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
  build: {
    target: 'es2022',
    /*
     * Not in production builds.
     *
     * The map is 850 KB — three times the bundle — and it was being copied into
     * the container and served publicly, on a deployment whose bandwidth is
     * metered. Development and preview keep it, which is where anyone actually
     * debugging this is standing.
     */
    sourcemap: process.env.NODE_ENV !== 'production',
  },
});
