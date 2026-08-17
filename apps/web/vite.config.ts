import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss()],

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
    sourcemap: true,
  },
});
