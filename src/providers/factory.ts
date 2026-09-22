/**
 * Provider factory: builds the active LLMProvider from typed settings.
 *
 * Instances are cached per configuration snapshot and rebuilt when the
 * configuration changes. EE-3 calls invalidateProviderCache() from
 * onDidChangeConfiguration (for `omnichat.*`) and after any secret
 * store/forget, so a fresh provider is built on next use.
 */

import * as vscode from 'vscode';
import { GenericOpenAICompatibleProvider } from './genericOpenAI.js';
import { OllamaProvider } from './ollama.js';
import { OpenRouterProvider } from './openrouter.js';
import { CUSTOM_API_KEY, OPENROUTER_API_KEY, optionalSecret, requireSecret } from '../state/secrets.js';
import { readSettings } from '../state/settings.js';
import type { LLMProvider } from './types.js';

const cache = new Map<string, LLMProvider>();

/**
 * Snapshot key covering everything that determines which provider instance
 * to build. Secrets are deliberately excluded: a secret change must be
 * followed by invalidateProviderCache() (documented for EE-3) because
 * SecretStorage has no change event.
 */
function snapshotKey(): string {
  const s = readSettings();
  return JSON.stringify({
    provider: s.provider,
    ollamaBaseUrl: s.ollama.baseUrl,
    openrouterModel: s.openrouter.model,
    customBaseUrl: s.custom.baseUrl,
    customModel: s.custom.model,
    customApiKeyRequired: s.custom.apiKeyRequired,
  });
}

/**
 * Build (or return the cached) provider for the current configuration.
 * Missing OpenRouter key throws OmniChatError('UNAUTHORIZED') via
 * requireSecret so the error presenter routes to key entry.
 */
export async function createProvider(ctx: vscode.ExtensionContext): Promise<LLMProvider> {
  const key = snapshotKey();
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const settings = readSettings();
  let provider: LLMProvider;
  switch (settings.provider) {
    case 'ollama':
      provider = new OllamaProvider(settings.ollama.baseUrl);
      break;
    case 'openrouter':
      provider = new OpenRouterProvider(await requireSecret(ctx, OPENROUTER_API_KEY));
      break;
    case 'custom': {
      const apiKey = settings.custom.apiKeyRequired
        ? await requireSecret(ctx, CUSTOM_API_KEY)
        : await optionalSecret(ctx, CUSTOM_API_KEY);
      provider = new GenericOpenAICompatibleProvider(settings.custom.baseUrl, apiKey, {
        defaultModel: settings.custom.model,
      });
      break;
    }
  }
  cache.set(key, provider);
  return provider;
}

/**
 * Drop all cached provider instances. Call from onDidChangeConfiguration
 * for `omnichat.*` and after storing or forgetting an API key.
 */
export function invalidateProviderCache(): void {
  cache.clear();
}
