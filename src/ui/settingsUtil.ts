/**
 * Small shared helpers over the typed settings reader.
 *
 * The single typed reader stays src/state/settings.ts (readSettings); this
 * module adds the derived values the UI layer needs everywhere: the active
 * model for the current provider, display names, privacy labels, and the
 * functional "is setup complete" check.
 */

import * as vscode from 'vscode';
import type { ProviderId } from '../providers/types.js';
import { OPENROUTER_API_KEY, optionalSecret } from '../state/secrets.js';
import { readSettings, type OmniChatSettings } from '../state/settings.js';
import { privacyLabel } from '../util/privacy.js';

/** The model id that serves the next chat for the active provider. */
export function activeModel(s: OmniChatSettings): string {
  switch (s.provider) {
    case 'ollama':
      return s.ollama.model;
    case 'openrouter':
      return s.openrouter.model;
    case 'custom':
      return s.custom.model;
  }
}

/** The settings key holding the model for a provider. */
export function modelSettingKey(provider: ProviderId): string {
  switch (provider) {
    case 'ollama':
      return 'ollama.model';
    case 'openrouter':
      return 'openrouter.model';
    case 'custom':
      return 'custom.model';
  }
}

export function providerDisplayName(id: ProviderId): string {
  switch (id) {
    case 'ollama':
      return 'Ollama';
    case 'openrouter':
      return 'OpenRouter';
    case 'custom':
      return 'Custom endpoint';
  }
}

/** Short privacy tag for the status bar tooltip. */
export function privacyTag(s: OmniChatSettings): string {
  if (s.provider === 'ollama') {
    return isLocalhostUrl(s.ollama.baseUrl) ? 'Private' : 'Network';
  }
  if (s.provider === 'openrouter') {
    return 'Cloud';
  }
  return 'Custom';
}

export function isLocalhostUrl(url: string): boolean {
  return /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i.test(url.trim());
}

/** Per-provider privacy line (UX Designer's exact copy via util/privacy.ts). */
export function privacyLabelFor(s: OmniChatSettings): string {
  if (s.provider === 'ollama') {
    const local = isLocalhostUrl(s.ollama.baseUrl);
    return privacyLabel({
      kind: 'ollama',
      isLocal: local,
      baseUrl: local ? undefined : s.ollama.baseUrl,
    });
  }
  if (s.provider === 'openrouter') {
    return privacyLabel({ kind: 'openrouter', isLocal: false });
  }
  return privacyLabel({ kind: 'custom', isLocal: false });
}

/** Write one omnichat.* setting (Global target). */
export async function updateSetting(key: string, value: unknown): Promise<void> {
  await vscode.workspace
    .getConfiguration('omnichat')
    .update(key, value, vscode.ConfigurationTarget.Global);
}

/**
 * Functional setup-complete check: a provider is selected, its model is set,
 * and the pieces the provider needs (key, base URL) are present. The wizard
 * sets all of these at Done; manual configuration also counts.
 */
export async function isSetupComplete(
  ctx: vscode.ExtensionContext,
): Promise<boolean> {
  const s = readSettings();
  if (!activeModel(s)) {
    return false;
  }
  if (s.provider === 'openrouter') {
    return (await optionalSecret(ctx, OPENROUTER_API_KEY)) !== undefined;
  }
  if (s.provider === 'custom') {
    return s.custom.baseUrl.trim().length > 0;
  }
  return true;
}
