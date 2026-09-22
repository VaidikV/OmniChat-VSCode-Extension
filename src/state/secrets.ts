/**
 * SecretStorage wrapper for API keys.
 *
 * Decision #15: API keys live ONLY in VS Code SecretStorage, never in
 * settings JSON, globalState, or logs. These are the only functions that
 * touch SecretStorage for OmniChat keys.
 */

import * as vscode from 'vscode';
import { OmniChatError } from '../providers/errors.js';
import type { ProviderId } from '../providers/types.js';

/** OpenRouter API key. */
export const OPENROUTER_API_KEY = 'omnichat.openrouter.apiKey';
/** Custom endpoint API key (used only when omnichat.custom.apiKeyRequired). */
export const CUSTOM_API_KEY = 'omnichat.custom.apiKey';

export type SecretKey = typeof OPENROUTER_API_KEY | typeof CUSTOM_API_KEY;

function providerIdForKey(key: SecretKey): ProviderId {
  return key === OPENROUTER_API_KEY ? 'openrouter' : 'custom';
}

/**
 * Fetch a required secret. Throws OmniChatError('UNAUTHORIZED', providerId)
 * when the secret is missing or empty, so the error presenter can route to
 * the key-entry flow.
 */
export async function requireSecret(
  ctx: vscode.ExtensionContext,
  key: SecretKey,
): Promise<string> {
  const value = await ctx.secrets.get(key);
  if (!value) {
    throw new OmniChatError('UNAUTHORIZED', providerIdForKey(key));
  }
  return value;
}

/** Fetch an optional secret; undefined when absent or empty. */
export async function optionalSecret(
  ctx: vscode.ExtensionContext,
  key: SecretKey,
): Promise<string | undefined> {
  const value = await ctx.secrets.get(key);
  return value || undefined;
}

/** Store a secret. Only call with user-entered values from the key flow. */
export async function storeSecret(
  ctx: vscode.ExtensionContext,
  key: SecretKey,
  value: string,
): Promise<void> {
  await ctx.secrets.store(key, value);
}

/** Delete a secret ("forget key" action). */
export async function forgetSecret(
  ctx: vscode.ExtensionContext,
  key: SecretKey,
): Promise<void> {
  await ctx.secrets.delete(key);
}
