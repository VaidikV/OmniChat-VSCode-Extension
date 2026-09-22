import { test } from 'node:test';
import assert from 'node:assert/strict';

const { privacyLabel } = await import('./privacy.bundle.mjs');

test('ollama local', () => {
  assert.equal(
    privacyLabel({ kind: 'ollama', isLocal: true }),
    'Private: everything stays on this computer.'
  );
});

test('ollama non-localhost baseUrl', () => {
  assert.equal(
    privacyLabel({ kind: 'ollama', isLocal: false, baseUrl: 'http://192.168.1.10:11434' }),
    'Network: prompts go to http://192.168.1.10:11434.'
  );
});

test('openrouter', () => {
  assert.equal(
    privacyLabel({ kind: 'openrouter', isLocal: false }),
    'Cloud: your messages go to OpenRouter.'
  );
});

test('custom', () => {
  assert.equal(
    privacyLabel({ kind: 'custom', isLocal: false, baseUrl: 'http://localhost:1234/v1' }),
    "Check your service's privacy policy, OmniChat just passes messages through."
  );
});

test('no em dashes in any label', () => {
  const labels = [
    privacyLabel({ kind: 'ollama', isLocal: true }),
    privacyLabel({ kind: 'ollama', isLocal: false, baseUrl: 'http://x' }),
    privacyLabel({ kind: 'openrouter', isLocal: false }),
    privacyLabel({ kind: 'custom', isLocal: false }),
  ];
  for (const label of labels) {
    assert.ok(!label.includes('\u2014'), `em dash in: ${label}`);
  }
});
