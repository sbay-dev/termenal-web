import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// harfbuzzjs ships ESM with a top-level await and locates its .wasm via
// `new URL('harfbuzz.wasm', import.meta.url)`. Excluding it from dep
// pre-bundling keeps that URL pointing at the real package dir so Vite serves
// the wasm correctly (and avoids esbuild choking on the top-level await).
const root = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);

// @xterm/headless@6 ships its ESM build at lib-headless/xterm-headless.mjs, but
// its package.json `module` field points at a non-existent lib/xterm.mjs, so
// Vite/esbuild fail to resolve the bare specifier. Alias it to the real file.
const xtermHeadless = require.resolve('@xterm/headless/lib-headless/xterm-headless.mjs');

export default defineConfig({
  resolve: {
    alias: {
      '@xterm/headless': xtermHeadless,
    },
  },
  optimizeDeps: {
    exclude: ['harfbuzzjs'],
  },
  server: {
    host: '127.0.0.1',
    port: 5178,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        terminal: resolve(root, 'terminal.html'),
      },
    },
  },
});
