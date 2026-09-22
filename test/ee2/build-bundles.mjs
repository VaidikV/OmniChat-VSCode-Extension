/**
 * Rebuild the esbuild bundles that the ee2 tests import.
 *
 * The tests (html/render/privacy) assert against the exact shipped source
 * (CSP policy, markdown sanitization, privacy labels), so the bundles are
 * regenerated from src/ on every `npm run test:ee2` instead of being
 * committed. Output lands next to the tests: test/ee2/*.bundle.mjs
 * (gitignored build artifacts).
 */

import { buildSync } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(repoRoot, 'test', 'ee2');

const entries = {
  'html.bundle.mjs': 'src/ui/html.ts',
  'privacy.bundle.mjs': 'src/util/privacy.ts',
  'render.bundle.mjs': 'src/webview-src/render.ts',
};

for (const [outfile, entry] of Object.entries(entries)) {
  buildSync({
    entryPoints: [join(repoRoot, entry)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: join(outDir, outfile),
    logLevel: 'warning',
  });
}

console.log('ee2 bundles rebuilt from src/');
