/**
 * Generic OpenAI-compatible endpoint provider (LM Studio, vLLM, llama.cpp
 * server, text-generation-webui, ...).
 *
 * Same wire format as OpenRouter: POST {base}/v1/chat/completions with
 * stream: true (SSE). listModels() tries GET {base}/v1/models and falls back
 * to the configured default model as a single entry.
 *
 * isLocal is false: for arbitrary endpoints OmniChat cannot know where
 * prompts go, so the UI must label this a custom endpoint with a verify-it-
 * yourself privacy note (UX owns the copy).
 */

import { OmniChatError, httpToError } from './errors.js';
import { isAbortError, readSse } from './stream.js';
import type {
  ChatRequest,
  LLMProvider,
  ModelInfo,
  ProviderId,
  StreamEvent,
} from './types.js';
import { DEFAULT_STALL_TIMEOUT_MS } from './types.js';

const CONNECTION_TIMEOUT_MS = 10_000;

export interface GenericOpenAIOptions {
  /** Used as the single listModels() entry when GET /models fails. */
  defaultModel?: string;
}

/**
 * Normalize a user-entered base URL (FR-08b): trailing slashes are stripped
 * and a missing /v1 suffix is added, so both
 * `http://localhost:1234` and `http://localhost:1234/v1` work.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

export class GenericOpenAICompatibleProvider implements LLMProvider {
  readonly id: ProviderId = 'custom';
  readonly displayName = 'Custom endpoint';
  readonly isLocal = false;

  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly defaultModel?: string;

  constructor(baseUrl: string, apiKey?: string, options?: GenericOpenAIOptions) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.apiKey = apiKey || undefined;
    this.defaultModel = options?.defaultModel || undefined;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  /** Reachable when /models answers; 401 maps to UNAUTHORIZED. */
  async checkConnection(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw err;
      }
      throw new OmniChatError('NETWORK_ERROR', this.id, { baseUrl: this.baseUrl });
    }
    if (res.status === 401) {
      throw new OmniChatError('UNAUTHORIZED', this.id);
    }
    if (!res.ok) {
      throw new OmniChatError('NETWORK_ERROR', this.id, {
        baseUrl: this.baseUrl,
        status: String(res.status),
      });
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw httpToError(res, this.id);
      }
      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      const models = (data.data ?? [])
        .filter((m) => typeof m.id === 'string' && m.id.length > 0)
        .map((m) => ({ id: m.id as string, label: m.id as string }));
      if (models.length > 0) {
        return models;
      }
    } catch (err) {
      if (err instanceof OmniChatError && err.code === 'UNAUTHORIZED') {
        throw err;
      }
      // Fall through to the configured default below.
    }
    if (this.defaultModel) {
      return [
        {
          id: this.defaultModel,
          label: this.defaultModel,
          description: 'Configured default model',
        },
      ];
    }
    return [];
  }

  async *chatStream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: req.model, messages: req.messages, stream: true }),
        signal: req.signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw err;
      }
      throw new OmniChatError('NETWORK_ERROR', this.id, { baseUrl: this.baseUrl });
    }
    if (!res.ok || !res.body) {
      throw httpToError(res, this.id, 'MODEL_NOT_FOUND');
    }
    try {
      yield* readSse(
        res.body,
        (data) => {
          if (data.trim() === '[DONE]') {
            return 'done';
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            return null;
          }
          const delta = (parsed as { choices?: Array<{ delta?: { content?: string; reasoning?: string } }> })
            .choices?.[0]?.delta;
          if (delta?.reasoning) {
            return { type: 'reasoning', text: delta.reasoning };
          }
          if (delta?.content) {
            return { type: 'token', text: delta.content };
          }
          return null;
        },
        {
          signal: req.signal,
          stallTimeoutMs: req.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
          providerId: this.id,
        },
      );
    } catch (err) {
      if (isAbortError(err) || err instanceof OmniChatError) {
        throw err;
      }
      throw new OmniChatError('NETWORK_ERROR', this.id, { baseUrl: this.baseUrl });
    }
  }
}
