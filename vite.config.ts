import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  // The About dialog shows the version the build actually produced. about-data.js
  // carries one baked at sync time as a fallback, and it goes stale the moment a
  // release is tagged; this is the one that is always right.
  define: { __APP_VERSION__: JSON.stringify(`v${pkg.version}`) },
  plugins: [react()],
  build: {
    // three is ~600 kB minified on its own and would otherwise trip the default
    // chunk-size warning on every build, which trains you to ignore it.
    chunkSizeWarningLimit: 1200,
  },
  worker: {
    // The solver worker is an ES module (it imports from src/domain). Vite's
    // default worker format is 'iife', which cannot carry static imports.
    format: 'es',
  },
});
