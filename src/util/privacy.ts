/**
 * Per-provider privacy labels. Pure module: no 'vscode' import, unit-testable.
 * Copy is the UX Designer's exact wording (phase-0/ux-wizard-flow.md, welcome
 * view section); do not paraphrase.
 */

import type { ProviderId } from '../providers/types.js';

/** Provider kinds known to the privacy label layer. Aliased to the
 *  provider abstraction's ProviderId now that EE-1's types exist. */
export type PrivacyProviderKind = ProviderId;

export interface PrivacyLabelInput {
  kind: PrivacyProviderKind;
  /** True when the provider runs on this machine (drives the privacy label). */
  isLocal: boolean;
  /** Endpoint the provider talks to; used for non-local Ollama labels. */
  baseUrl?: string;
}

export function privacyLabel(input: PrivacyLabelInput): string {
  if (input.kind === 'ollama') {
    if (!input.isLocal) {
      return `Network: prompts go to ${input.baseUrl ?? 'the configured address'}.`;
    }
    return 'Private: everything stays on this computer.';
  }
  if (input.kind === 'openrouter') {
    return 'Cloud: your messages go to OpenRouter.';
  }
  return "Check your service's privacy policy, OmniChat just passes messages through.";
}
