import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
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
