/**
 * Unit tests for src/state/settings.ts (pure applyDefaults).
 * Run under plain node:test (no vscode, no Electron).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, applyDefaults } from './settings.js';

describe('applyDefaults', () => {
  it('returns defaults for an empty partial', () => {
    assert.deepEqual(applyDefaults({}), DEFAULT_SETTINGS);
  });

  it('merges partial values over defaults', () => {
    const settings = applyDefaults({
      provider: 'openrouter',
      ollama: { model: 'llama3.1:8b' },
    });
    assert.equal(settings.provider, 'openrouter');
    assert.equal(settings.ollama.model, 'llama3.1:8b');
    assert.equal(settings.ollama.baseUrl, DEFAULT_SETTINGS.ollama.baseUrl);
    assert.equal(settings.openrouter.model, DEFAULT_SETTINGS.openrouter.model);
  });

  it('falls back to ollama for an unknown provider', () => {
    const settings = applyDefaults({ provider: 'unknown' as never });
    assert.equal(settings.provider, 'ollama');
  });

  it('clamps requestTimeout to the minimum of 30', () => {
    assert.equal(applyDefaults({ requestTimeout: 10 }).requestTimeout, 30);
    assert.equal(applyDefaults({ requestTimeout: 30 }).requestTimeout, 30);
    assert.equal(applyDefaults({ requestTimeout: 600 }).requestTimeout, 600);
    assert.equal(applyDefaults({ requestTimeout: NaN }).requestTimeout, 300);
  });

  it('falls back on non-string baseUrl values', () => {
    const settings = applyDefaults({ ollama: { baseUrl: 42 as never } });
    assert.equal(settings.ollama.baseUrl, DEFAULT_SETTINGS.ollama.baseUrl);
  });

  it('keeps empty-string models (meaning unset)', () => {
    const settings = applyDefaults({ custom: { model: '' } });
    assert.equal(settings.custom.model, '');
  });
});
