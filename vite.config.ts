// vitest/config's defineConfig is Vite's with the `test` block typed; Vite's
// own would reject the key below.
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/**
 * Stamp the version this build produced onto the support-footer script tag.
 *
 * The tag itself stays in index.html — it is the same document in dev — but the
 * version cannot be written in beside it: a literal goes stale the moment a
 * release is tagged, and a feedback report naming the wrong build is worse than
 * one naming no build at all. Same string as __APP_VERSION__ below, which is
 * what the About dialog shows.
 */
function supportFooterVersion(): Plugin {
  // Not anchored to a leading slash: this runs after Vite has rewritten public
  // asset paths, and an app built with a relative `base` has ./support-footer.js
  // by the time we see it.
  const tag = /<script\s[^>]*\bsrc="[^"]*support-footer\.js"/
  return {
    name: 'stoatworks-support-footer-version',
    transformIndexHtml: {
      order: 'post',
      handler(html: string) {
        // Loud on purpose. The tag is hand-written markup, so a rename or a
        // tidy-up could silently detach the version from every report filed
        // afterwards, and nothing downstream would look wrong.
        if (!tag.test(html)) {
          throw new Error('no support-footer.js tag in index.html — nothing to stamp')
        }
        return html.replace(tag, (m) => `${m} data-version="v${pkg.version}"`)
      }
    }
  }
}

export default defineConfig({
  // The About dialog shows the version the build actually produced. about-data.js
  // carries one baked at sync time as a fallback, and it goes stale the moment a
  // release is tagged; this is the one that is always right.
  define: { __APP_VERSION__: JSON.stringify(`v${pkg.version}`) },
  plugins: [react(), supportFooterVersion()],
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
  test: {
    benchmark: {
      // vitest 5 warns when a benchmarked path reads a module export "too many
      // times" through the getter its module runner puts on every cross-module
      // import. The one it flags here is `sampleCosTable`, which `solve` calls
      // once per sample point. That overhead is the same for every case, was
      // there just as silently under vitest 4 (the AGENTS.md table was measured
      // with it), and is not in the production bundle, where the import is a
      // direct binding. The numbers compare cases and before/after; they were
      // never absolutes, and seven copies of the warning per run only bury the
      // tables they qualify. The tracker behind the warning costs more than the
      // getters it counts, too: "18 analytic" ran at ~5,000 hz with it on and
      // ~9,500 hz with it off, on the same machine in the same minute.
      suppressExportGetterWarnings: true,
    },
  },
});
