/**
 * Unit tests for src/providers/errors.ts.
 * Run under plain node:test (no vscode, no Electron).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_CODES,
  OmniChatError,
  httpToError,
  recoveryFor,
} from './errors.js';
import type { RecoveryActionId } from './errors.js';

function responseWithStatus(status: number): Response {
  return new Response(null, { status });
}

describe('httpToError', () => {
  it('maps 401 to UNAUTHORIZED', () => {
    assert.equal(httpToError(responseWithStatus(401), 'openrouter').code, 'UNAUTHORIZED');
  });

  it('maps 402 to PAYMENT_REQUIRED', () => {
    assert.equal(httpToError(responseWithStatus(402), 'openrouter').code, 'PAYMENT_REQUIRED');
  });

  it('maps 429 to RATE_LIMITED', () => {
    assert.equal(httpToError(responseWithStatus(429), 'custom').code, 'RATE_LIMITED');
  });

  it('maps 404 to MODEL_NOT_FOUND by default', () => {
    assert.equal(httpToError(responseWithStatus(404), 'openrouter').code, 'MODEL_NOT_FOUND');
  });

  it('maps 404 to MODEL_NOT_INSTALLED with the Ollama hint', () => {
    assert.equal(
      httpToError(responseWithStatus(404), 'ollama', 'MODEL_NOT_INSTALLED').code,
      'MODEL_NOT_INSTALLED',
    );
  });

  it('maps other statuses to NETWORK_ERROR', () => {
    assert.equal(httpToError(responseWithStatus(500), 'ollama').code, 'NETWORK_ERROR');
    assert.equal(httpToError(responseWithStatus(503), 'custom').code, 'NETWORK_ERROR');
  });

  it('carries the provider id', () => {
    const err = httpToError(responseWithStatus(401), 'custom');
    assert.ok(err instanceof OmniChatError);
    assert.equal(err.providerId, 'custom');
  });
});

describe('recoveryFor', () => {
  const knownActions: RecoveryActionId[] = [
    'start-ollama',
    'retry',
    'open-setup',
    'switch-provider',
    'pull-model',
    'pick-model',
    'reenter-key',
    'get-key',
    'open-billing',
    'copy-details',
    'use-openrouter',
    'use-ollama',
    'show-start-guide',
    'edit-endpoint',
    'test-connection',
    'check-again',
  ];

  it('covers every ErrorCode with at least one action', () => {
    for (const code of ERROR_CODES) {
      const recovery = recoveryFor(code, {
        model: 'llama3.1:8b',
        baseUrl: 'http://127.0.0.1:11434',
        providerDisplayName: 'OpenRouter',
      });
      assert.ok(
        recovery.actions.length >= 1,
        `${code} must have at least one recovery action`,
      );
      assert.ok(recovery.title.length > 0, `${code} must have a title`);
      assert.ok(recovery.message.length > 0, `${code} must have a message`);
      for (const action of recovery.actions) {
        assert.ok(
          knownActions.includes(action.id),
          `${code}: unknown action id "${action.id}"`,
        );
        assert.ok(action.label.length > 0, `${code}: action label must not be empty`);
      }
    }
  });

  it('uses no em dashes in user-facing copy', () => {
    for (const code of ERROR_CODES) {
      const recovery = recoveryFor(code);
      for (const text of [recovery.title, recovery.message, ...recovery.actions.map((a) => a.label)]) {
        assert.ok(!text.includes('—'), `${code}: em dash found in "${text}"`);
      }
    }
  });

  it('interpolates context without leaking raw errors', () => {
    const recovery = recoveryFor('MODEL_NOT_INSTALLED', { model: 'qwen3:4b' });
    assert.ok(recovery.message.includes('qwen3:4b'));
    assert.ok(!recovery.message.includes('Error'));
  });

  it('OLLAMA_UNREACHABLE offers Start Ollama, Use OpenRouter instead, and Edit host', () => {
    const recovery = recoveryFor('OLLAMA_UNREACHABLE', {
      baseUrl: 'http://127.0.0.1:11434',
    });
    const byId = new Map(recovery.actions.map((a) => [a.id, a.label]));
    assert.equal(byId.get('start-ollama'), 'Start Ollama');
    assert.equal(byId.get('use-openrouter'), 'Use OpenRouter instead');
    assert.equal(byId.get('edit-endpoint'), 'Edit host');
    assert.ok(recovery.message.includes('http://127.0.0.1:11434'));
  });
});
