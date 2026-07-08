import { defineConfig } from 'vite';

// harfbuzzjs ships ESM with a top-level await and locates its .wasm via
// `new URL('harfbuzz.wasm', import.meta.url)`. Excluding it from dep
// pre-bundling keeps that URL pointing at the real package dir so Vite serves
// the wasm correctly (and avoids esbuild choking on the top-level await).
export default defineConfig({
  optimizeDeps: {
    exclude: ['harfbuzzjs'],
  },
  server: {
    host: '127.0.0.1',
    port: 5178,
    strictPort: true,
  },
});
