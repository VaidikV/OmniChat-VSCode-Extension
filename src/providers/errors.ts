/**
 * OmniChat error taxonomy.
 *
 * Pure module: MUST NOT import 'vscode'. Unit-testable under plain node.
 *
 * Every provider failure maps to a stable ErrorCode; recoveryFor() pairs
 * each code with a plain-language title/message and ordered fix actions.
 * No raw String(err) or stack trace may reach the UI through this module.
 *
 * User-facing copy rule: no em dashes anywhere (use commas, colons, periods).
 */

import type { ProviderId } from './types.js';

export type ErrorCode =
  | 'OLLAMA_UNREACHABLE'
  | 'OLLAMA_START_FAILED'
  | 'MODEL_NOT_INSTALLED'
  | 'MODEL_REMOVED'
  | 'PULL_FAILED'
  | 'UNAUTHORIZED'
  | 'PAYMENT_REQUIRED'
  | 'RATE_LIMITED'
  | 'MODEL_NOT_FOUND'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'UNKNOWN';

export const ERROR_CODES: readonly ErrorCode[] = [
  'OLLAMA_UNREACHABLE',
  'OLLAMA_START_FAILED',
  'MODEL_NOT_INSTALLED',
  'MODEL_REMOVED',
  'PULL_FAILED',
  'UNAUTHORIZED',
  'PAYMENT_REQUIRED',
  'RATE_LIMITED',
  'MODEL_NOT_FOUND',
  'NETWORK_ERROR',
  'TIMEOUT',
  'CANCELLED',
  'UNKNOWN',
];

export class OmniChatError extends Error {
  readonly code: ErrorCode;
  readonly providerId?: ProviderId;
  /** Extra context for copy interpolation (model id, base URL, ...). Never secrets. */
  readonly detail?: Record<string, string>;

  constructor(code: ErrorCode, providerId?: ProviderId, detail?: Record<string, string>) {
    super(code);
    this.name = 'OmniChatError';
    this.code = code;
    this.providerId = providerId;
    this.detail = detail;
  }
}

/**
 * Central HTTP status to error-code mapping. No provider invents its own codes.
 *
 * 404 handling: callers pass a hint because the same status means different
 * things per endpoint. Ollama /api/chat and /api/pull on an unknown model
 * name pass 'MODEL_NOT_INSTALLED' ("Model {id} is not installed."); cloud
 * providers on an unknown model id pass 'MODEL_NOT_FOUND' ("The provider
 * does not serve {id}."). The default is 'MODEL_NOT_FOUND'.
 */
export function httpToError(
  res: Response,
  providerId: ProviderId,
  notFoundCode: 'MODEL_NOT_INSTALLED' | 'MODEL_NOT_FOUND' = 'MODEL_NOT_FOUND',
): OmniChatError {
  switch (res.status) {
    case 401:
      return new OmniChatError('UNAUTHORIZED', providerId);
    case 402:
      return new OmniChatError('PAYMENT_REQUIRED', providerId);
    case 404:
      return new OmniChatError(notFoundCode, providerId);
    case 429:
      return new OmniChatError('RATE_LIMITED', providerId);
    default:
      return new OmniChatError('NETWORK_ERROR', providerId, { status: String(res.status) });
  }
}

// ---------------------------------------------------------------------------
// Recovery actions
// ---------------------------------------------------------------------------

/**
 * Stable action-id vocabulary for recovery buttons. EE-3 implements the host
 * side of each action (errorPresenter.ts / wizard / model picker).
 *
 *  - start-ollama:      Spawn `ollama serve` detached and poll /api/version
 *                       (explicit user click only, decision #27), with the
 *                       terminal fallback if spawn fails.
 *  - retry:             Retry the failed operation unchanged.
 *  - open-setup:        Open the OmniChat setup wizard.
 *  - switch-provider:   Open the provider/model switcher.
 *  - pull-model:        Pull the missing model with progress and cancel.
 *  - pick-model:        Open the model picker (choose a different model).
 *  - reenter-key:       Open the password-style API key entry flow.
 *  - get-key:           Open the provider's API key page in the browser.
 *  - open-billing:      Open the provider's billing page in the browser.
 *  - copy-details:      Copy technical error details to the clipboard.
 *  - use-openrouter:    Switch to the OpenRouter provider.
 *  - use-ollama:        Switch to the Ollama provider.
 *  - show-start-guide:  Show the copyable manual `ollama serve` command.
 *  - edit-endpoint:     Open the custom endpoint URL for editing.
 *  - test-connection:   Re-run checkConnection() against the endpoint.
 *  - check-again:       Re-run Ollama detection.
 */
export type RecoveryActionId =
  | 'start-ollama'
  | 'retry'
  | 'open-setup'
  | 'switch-provider'
  | 'pull-model'
  | 'pick-model'
  | 'reenter-key'
  | 'get-key'
  | 'open-billing'
  | 'copy-details'
  | 'use-openrouter'
  | 'use-ollama'
  | 'show-start-guide'
  | 'edit-endpoint'
  | 'test-connection'
  | 'check-again';

export interface RecoveryAction {
  id: RecoveryActionId;
  label: string;
}

export interface Recovery {
  title: string;
  message: string;
  actions: RecoveryAction[];
}

export interface RecoveryContext {
  /** Model id for messages like "Model {id} is not installed." */
  model?: string;
  /** Base URL for messages like "could not reach Ollama at {baseUrl}." */
  baseUrl?: string;
  /** Human provider name, e.g. "OpenRouter". */
  providerDisplayName?: string;
}

function ctxModel(ctx?: RecoveryContext): string {
  return ctx?.model ? ` ${ctx.model}` : '';
}

function ctxProvider(ctx?: RecoveryContext, fallback = 'the provider'): string {
  return ctx?.providerDisplayName ?? fallback;
}

/**
 * Map an ErrorCode to its recovery presentation. Every code returns at
 * least one action. CANCELLED is silent by convention (the orchestrator does
 * not present it), but still carries a retry action for completeness.
 */
export function recoveryFor(code: ErrorCode, ctx?: RecoveryContext): Recovery {
  switch (code) {
    case 'OLLAMA_UNREACHABLE':
      return {
        title: 'Ollama is not reachable',
        message: ctx?.baseUrl
          ? `OmniChat could not reach Ollama at ${ctx.baseUrl}. Start Ollama and try again.`
          : 'OmniChat could not reach Ollama. Start Ollama and try again.',
        actions: [
          { id: 'start-ollama', label: 'Start Ollama' },
          { id: 'use-openrouter', label: 'Use OpenRouter instead' },
          { id: 'edit-endpoint', label: 'Edit host' },
          { id: 'retry', label: 'Retry' },
          { id: 'check-again', label: 'Check again' },
          { id: 'open-setup', label: 'Open setup wizard' },
          { id: 'switch-provider', label: 'Switch provider' },
        ],
      };
    case 'OLLAMA_START_FAILED':
      return {
        title: "OmniChat couldn't start Ollama",
        message: 'The automatic start did not work. You can try again, see the manual command, or use OpenRouter instead.',
        actions: [
          { id: 'retry', label: 'Try again' },
          { id: 'show-start-guide', label: 'Show me how to start it' },
          { id: 'use-openrouter', label: 'Use OpenRouter instead' },
        ],
      };
    case 'MODEL_NOT_INSTALLED':
      return {
        title: 'Model is not installed',
        message: `Model${ctxModel(ctx)} is not installed. Pull it now, or choose a different model.`,
        actions: [
          { id: 'pull-model', label: 'Pull model now' },
          { id: 'pick-model', label: 'Choose a different model' },
        ],
      };
    case 'MODEL_REMOVED':
      return {
        title: "That model isn't installed anymore",
        message: 'The configured model is no longer available. Pick another model to continue.',
        actions: [{ id: 'pick-model', label: 'Pick another model' }],
      };
    case 'PULL_FAILED':
      return {
        title: 'The download was interrupted',
        message: 'The model download did not complete. Try again, or pick a smaller model.',
        actions: [
          { id: 'retry', label: 'Try again' },
          { id: 'pick-model', label: 'Pick a smaller model' },
          { id: 'use-openrouter', label: 'Use OpenRouter instead' },
        ],
      };
    case 'UNAUTHORIZED':
      return {
        title: 'The API key was rejected',
        message: `The API key was missing or was rejected by ${ctxProvider(ctx)}. Re-enter the key to continue.`,
        actions: [
          { id: 'reenter-key', label: 'Re-enter API key' },
          { id: 'get-key', label: 'Get an API key' },
          { id: 'switch-provider', label: 'Switch provider' },
        ],
      };
    case 'PAYMENT_REQUIRED':
      return {
        title: 'Billing is required',
        message: `${ctxProvider(ctx)} needs billing set up before you can chat.`,
        actions: [
          { id: 'open-billing', label: 'Open billing page' },
          { id: 'use-ollama', label: 'Use Ollama instead' },
        ],
      };
    case 'RATE_LIMITED':
      return {
        title: 'Rate limit reached',
        message: `${ctxProvider(ctx)} is rate-limiting requests. Wait a moment, then retry.`,
        actions: [
          { id: 'retry', label: 'Retry' },
          { id: 'switch-provider', label: 'Switch provider' },
        ],
      };
    case 'MODEL_NOT_FOUND':
      return {
        title: 'Model not found',
        message: `${ctxProvider(ctx)} does not serve${ctxModel(ctx)}. Choose a different model.`,
        actions: [{ id: 'pick-model', label: 'Choose a different model' }],
      };
    case 'NETWORK_ERROR':
      return {
        title: 'Could not reach the provider',
        message: `Could not reach ${ctxProvider(ctx)}. Check your connection and try again.`,
        actions: [
          { id: 'retry', label: 'Retry' },
          { id: 'test-connection', label: 'Test connection again' },
          { id: 'edit-endpoint', label: 'Edit endpoint' },
          { id: 'switch-provider', label: 'Switch provider' },
        ],
      };
    case 'TIMEOUT':
      return {
        title: 'The request timed out',
        message: 'No tokens arrived for a while, so the request was cancelled. Retry, or choose a smaller or faster model.',
        actions: [
          { id: 'retry', label: 'Retry' },
          { id: 'pick-model', label: 'Choose a smaller or faster model' },
        ],
      };
    case 'CANCELLED':
      return {
        title: 'Generation stopped',
        message: 'The response was stopped. The text so far is kept above.',
        actions: [{ id: 'retry', label: 'Retry' }],
      };
    case 'UNKNOWN':
      return {
        title: 'Something unexpected happened',
        message: 'An unexpected error occurred. Copy the details if you need to report it.',
        actions: [
          { id: 'copy-details', label: 'Copy error details' },
          { id: 'retry', label: 'Retry' },
          { id: 'open-setup', label: 'Open setup wizard' },
        ],
      };
  }
}
