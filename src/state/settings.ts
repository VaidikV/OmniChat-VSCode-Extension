/**
 * Single typed reader over workspace.getConfiguration('omnichat').
 * Nothing else in the extension reads getConfiguration('omnichat') directly.
 *
 * Defaults live in DEFAULT_SETTINGS and are applied by the pure
 * applyDefaults() function so the merging logic is unit-testable.
 *
 * The 'vscode' module is required lazily inside readSettings() (not at
 * import time) so the pure parts of this module stay importable under
 * plain node for unit tests.
 */

import type * as vscode from 'vscode';
import type { ProviderId } from '../providers/types.js';

export interface OllamaSettings {
  baseUrl: string;
  model: string;
}

export interface OpenRouterSettings {
  model: string;
}

export interface CustomSettings {
  baseUrl: string;
  model: string;
  apiKeyRequired: boolean;
}

export interface OmniChatSettings {
  provider: ProviderId;
  /** Seconds without a token before a request is treated as stalled (B1, decision #26). */
  requestTimeout: number;
  ollama: OllamaSettings;
  openrouter: OpenRouterSettings;
  custom: CustomSettings;
}

export const PROVIDER_IDS: readonly ProviderId[] = ['ollama', 'openrouter', 'custom'];

export const DEFAULT_SETTINGS: OmniChatSettings = {
  provider: 'ollama',
  requestTimeout: 300,
  ollama: {
    baseUrl: 'http://127.0.0.1:11434',
    model: '',
  },
  openrouter: {
    model: 'openai/gpt-oss-20b',
  },
  custom: {
    baseUrl: '',
    model: '',
    apiKeyRequired: false,
  },
};

/** Minimum allowed requestTimeout seconds (matches the configuration schema). */
export const MIN_REQUEST_TIMEOUT = 30;

type UnknownDeep<T> = {
  [K in keyof T]?: T[K] extends object ? UnknownDeep<T[K]> : unknown;
};

function pickString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickProvider(value: unknown): ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
    ? (value as ProviderId)
    : DEFAULT_SETTINGS.provider;
}

function pickRequestTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.requestTimeout;
  }
  return Math.max(MIN_REQUEST_TIMEOUT, Math.floor(value));
}

/**
 * Pure: merge a partial settings bag over the defaults.
 * Used by readSettings() and directly by unit tests.
 */
export function applyDefaults(partial: UnknownDeep<OmniChatSettings>): OmniChatSettings {
  const ollama = partial.ollama ?? {};
  const openrouter = partial.openrouter ?? {};
  const custom = partial.custom ?? {};
  return {
    provider: pickProvider(partial.provider),
    requestTimeout: pickRequestTimeout(partial.requestTimeout),
    ollama: {
      baseUrl: pickString(ollama.baseUrl, DEFAULT_SETTINGS.ollama.baseUrl),
      model: typeof ollama.model === 'string' ? ollama.model : DEFAULT_SETTINGS.ollama.model,
    },
    openrouter: {
      model: pickString(openrouter.model, DEFAULT_SETTINGS.openrouter.model),
    },
    custom: {
      baseUrl: typeof custom.baseUrl === 'string' ? custom.baseUrl : DEFAULT_SETTINGS.custom.baseUrl,
      model: typeof custom.model === 'string' ? custom.model : DEFAULT_SETTINGS.custom.model,
      apiKeyRequired: pickBoolean(custom.apiKeyRequired, DEFAULT_SETTINGS.custom.apiKeyRequired),
    },
  };
}

/** The single typed reader. Everything else goes through this. */
export function readSettings(): OmniChatSettings {
  // Lazy require keeps this module importable under plain node for tests.
  const vscodeApi = require('vscode') as typeof vscode;
  const cfg = vscodeApi.workspace.getConfiguration('omnichat');
  return applyDefaults({
    provider: cfg.get<unknown>('provider'),
    requestTimeout: cfg.get<unknown>('requestTimeout'),
    ollama: {
      baseUrl: cfg.get<unknown>('ollama.baseUrl'),
      model: cfg.get<unknown>('ollama.model'),
    },
    openrouter: {
      model: cfg.get<unknown>('openrouter.model'),
    },
    custom: {
      baseUrl: cfg.get<unknown>('custom.baseUrl'),
      model: cfg.get<unknown>('custom.model'),
      apiKeyRequired: cfg.get<unknown>('custom.apiKeyRequired'),
    },
  });
}
