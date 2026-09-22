/**
 * Unit tests for src/util/nonce.ts.
 * Run under plain node:test (no vscode, no Electron).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createNonce } from './nonce.js';

describe('createNonce', () => {
  it('produces unique values', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      seen.add(createNonce());
    }
    assert.equal(seen.size, 100);
  });

  it('is URL-safe base64 without padding', () => {
    for (let i = 0; i < 20; i += 1) {
      const nonce = createNonce();
      assert.match(nonce, /^[A-Za-z0-9_-]+$/);
      assert.ok(!nonce.includes('='), 'nonce must not contain padding');
    }
  });

  it('encodes 32 bytes by default (43 chars)', () => {
    assert.equal(createNonce().length, 43);
  });
});
