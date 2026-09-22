/**
 * Bundles the webview sources with esbuild:
 *   src/webview-src/main.ts    -> media/webview/bundle.js
 *   src/webview-src/welcome.ts -> media/webview/welcome.js
 *   src/webview-src/style.css  -> media/webview/bundle.css
 *
 * Run from the repo root:  node build-webview.mjs
 *
 * The webview is CSP-locked with connect-src 'none', so the bundles must
 * contain zero external URLs and zero console calls (console.* is dropped).
 */
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const src = (p) => resolve(root, p);

await mkdir(src('media/webview'), { recursive: true });

const scriptOptions = {
  bundle: true,
  platform: 'browser',
  format: 'iife',
  minify: true,
  drop: ['console'],
  target: ['es2020'],
};

await build({
  ...scriptOptions,
  entryPoints: [src('src/webview-src/main.ts')],
  outfile: src('media/webview/bundle.js'),
});

await build({
  ...scriptOptions,
  entryPoints: [src('src/webview-src/welcome.ts')],
  outfile: src('media/webview/welcome.js'),
});

await build({
  entryPoints: [src('src/webview-src/style.css')],
  bundle: true,
  minify: true,
  outfile: src('media/webview/bundle.css'),
});

console.log('webview bundles written to media/webview/');
