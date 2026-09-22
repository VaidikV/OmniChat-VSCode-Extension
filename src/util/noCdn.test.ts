/**
 * No-CDN static assertion (D18): the shipped extension must not load any
 * remote scripts, styles, fonts, images, or other web resources. All
 * third-party code (marked, DOMPurify) is bundled locally, and all webview
 * resources use the webview URI scheme with a strict CSP.
 *
 * This runs in the regular `npm run test:unit` command (node --test over the
 * compiled test files in out). It scans the shipped source trees: src/,
 * media/, and the compiled out/ output (minus sourcemaps).
 *
 * Sanctioned https:// strings that are NOT remote resources (and therefore
 * not matched here): provider API endpoints fetched by the extension host
 * (openrouter.ai/api), user-initiated browser opens (openExternal), and
 * XML namespace constants inside bundled libraries.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Repo root: walk up from this compiled test file (out/util/noCdn.test.js)
 * until package.json is found.
 */
function findRepoRoot(): string {
  let dir = __dirname;
  for (;;) {
    try {
      statSync(join(dir, 'package.json'));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) {
        throw new Error('no-CDN test: could not locate the repo root');
      }
      dir = parent;
    }
  }
}

const SCAN_DIRS = ['src', 'media', 'out'];
const SCAN_EXTENSIONS = new Set(['.ts', '.js', '.css', '.html', '.svg']);

function collectFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (entry === 'node_modules') {
          continue;
        }
        walk(full);
      } else if (SCAN_EXTENSIONS.has(entry.slice(entry.lastIndexOf('.')))) {
        // Test files are not shipped (excluded from the vsix) and may
        // legitimately mention remote URLs in assertions.
        if (/\.test\.(ts|js)$/.test(entry)) {
          continue;
        }
        files.push(full);
      }
    }
  };
  for (const d of SCAN_DIRS) {
    walk(join(root, d));
  }
  return files;
}

/** Patterns that indicate a remote resource load in shipped code. */
const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
  {
    name: 'remote script/style/media tag',
    pattern:
      /<(script|link|img|iframe|video|audio|source|embed|track)[^>]*?\b(?:src|href)\s*=\s*["']https?:\/\//i,
  },
  {
    name: 'remote CSS @import',
    pattern: /@import\s+(?:url\()?["']?https?:\/\//i,
  },
  {
    name: 'remote CSS url()',
    pattern: /\burl\(\s*["']?https?:\/\//i,
  },
  {
    name: 'known CDN host',
    pattern:
      /fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|ajax\.googleapis\.com/i,
  },
];

describe('no-CDN static assertion', () => {
  it('ships no remote script/style/font/image URLs', () => {
    const root = findRepoRoot();
    const files = collectFiles(root);
    assert.ok(files.length > 10, `expected to scan shipped files, found ${files.length}`);
    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const { name, pattern } of FORBIDDEN) {
        const match = text.match(pattern);
        if (match) {
          violations.push(
            `${file.replace(root + '/', '')}: ${name}: ${match[0].slice(0, 80)}`,
          );
        }
      }
    }
    assert.deepEqual(violations, [], `remote resource references found:\n${violations.join('\n')}`);
  });

  it('scans the compiled webview bundle too', () => {
    const root = findRepoRoot();
    const bundle = resolve(root, 'media/webview/bundle.js');
    try {
      statSync(bundle);
    } catch {
      assert.fail('media/webview/bundle.js is missing; run npm run compile first');
    }
    const text = readFileSync(bundle, 'utf8');
    // The webview runs under connect-src 'none'; it must never fetch remote URLs.
    const remoteFetch = text.match(/fetch\(\s*["']https?:\/\//);
    assert.equal(remoteFetch, null, `remote fetch in webview bundle: ${remoteFetch?.[0]}`);
  });
});
