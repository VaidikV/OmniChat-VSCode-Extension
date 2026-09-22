/**
 * Unit tests for the provider factory (src/providers/factory.ts).
 * Exercises createProviderFromSettings with a fake in-memory SecretStorage,
 * so no 'vscode' module is needed. Run under plain node:test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderFromSettings } from './factory.js';
import { GenericOpenAICompatibleProvider } from './genericOpenAI.js';
import { OllamaProvider } from './ollama.js';
import { OpenRouterProvider } from './openrouter.js';
import { OmniChatError } from './errors.js';
import { applyDefaults } from '../state/settings.js';
import type { SecretsHost } from '../state/secrets.js';

function fakeSecrets(store: Record<string, string> = {}): SecretsHost {
  return {
    secrets: {
      get: async (key: string) => store[key],
      store: async (key: string, value: string) => {
        store[key] = value;
      },
      delete: async (key: string) => {
        delete store[key];
      },
    },
  };
}

/** Await a promise expected to reject and return the rejection reason. */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

describe('createProviderFromSettings', () => {
  it('builds an OllamaProvider with the configured base URL', async () => {
    const provider = await createProviderFromSettings(
      applyDefaults({ provider: 'ollama', ollama: { baseUrl: 'http://127.0.0.1:11434' } }),
      fakeSecrets(),
    );
    assert.ok(provider instanceof OllamaProvider);
    assert.equal(provider.id, 'ollama');
    assert.equal((provider as OllamaProvider).baseUrl, 'http://127.0.0.1:11434');
    assert.equal(provider.isLocal, true);
  });

  it('builds an OpenRouterProvider when a key is stored', async () => {
    const provider = await createProviderFromSettings(
      applyDefaults({ provider: 'openrouter' }),
      fakeSecrets({ 'omnichat.openrouter.apiKey': 'sk-test' }),
    );
    assert.ok(provider instanceof OpenRouterProvider);
    assert.equal(provider.id, 'openrouter');
    assert.equal(provider.isLocal, false);
  });

  it('throws UNAUTHORIZED for OpenRouter without a stored key', async () => {
    const err = await captureRejection(
      createProviderFromSettings(applyDefaults({ provider: 'openrouter' }), fakeSecrets()),
  ) as OmniChatError;
    assert.equal(err.code, 'UNAUTHORIZED');
    assert.equal(err.providerId, 'openrouter');
  });

  it('builds a keyless custom provider when no key is required', async () => {
    const provider = await createProviderFromSettings(
      applyDefaults({
        provider: 'custom',
        custom: { baseUrl: 'http://localhost:1234', apiKeyRequired: false },
      }),
      fakeSecrets(),
    );
    assert.ok(provider instanceof GenericOpenAICompatibleProvider);
    assert.equal(provider.id, 'custom');
    assert.equal((provider as GenericOpenAICompatibleProvider).baseUrl, 'http://localhost:1234/v1');
  });

  it('throws UNAUTHORIZED for a custom endpoint that requires a missing key', async () => {
    const err = await captureRejection(
      createProviderFromSettings(
        applyDefaults({
          provider: 'custom',
          custom: { baseUrl: 'http://localhost:1234', apiKeyRequired: true },
        }),
        fakeSecrets(),
      ),
  ) as OmniChatError;
    assert.equal(err.code, 'UNAUTHORIZED');
    assert.equal(err.providerId, 'custom');
  });

  it('builds a custom provider with the stored key when required', async () => {
    const provider = await createProviderFromSettings(
      applyDefaults({
        provider: 'custom',
        custom: { baseUrl: 'http://localhost:1234', apiKeyRequired: true },
      }),
      fakeSecrets({ 'omnichat.custom.apiKey': 'custom-secret' }),
    );
    assert.ok(provider instanceof GenericOpenAICompatibleProvider);
    assert.equal(provider.id, 'custom');
  });

  it('falls back to the ollama provider for an unknown provider id', async () => {
    const provider = await createProviderFromSettings(
      applyDefaults({ provider: 'bogus' as never }),
      fakeSecrets(),
    );
    assert.ok(provider instanceof OllamaProvider);
  });
});
