/**
 * OpenRouter provider (OpenAI /v1/chat/completions wire format, SSE).
 *
 * The API key arrives via the constructor (from SecretStorage via the
 * factory). It is never logged and never embedded in errors.
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

const API_BASE = 'https://openrouter.ai/api/v1';
const CONNECTION_TIMEOUT_MS = 10_000;

export interface OpenRouterOptions {
  /** Sent as HTTP-Referer (OpenRouter attribution convention). */
  referer?: string;
}

function roundPrice(perMillion: number): string {
  if (perMillion >= 100) {
    return String(Math.round(perMillion));
  }
  if (perMillion >= 1) {
    return String(Math.round(perMillion * 100) / 100);
  }
  return String(Math.round(perMillion * 1000) / 1000);
}

/**
 * Human pricing hint from OpenRouter's pricing object
 * ({ prompt, completion } as strings, USD per token).
 */
export function pricingHint(pricing?: { prompt?: string; completion?: string }): string | undefined {
  if (!pricing) {
    return undefined;
  }
  const prompt = Number(pricing.prompt);
  const completion = Number(pricing.completion);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) {
    return undefined;
  }
  if (prompt === 0 && completion === 0) {
    return 'Free';
  }
  return `$${roundPrice(prompt * 1e6)}/1M in, $${roundPrice(completion * 1e6)}/1M out`;
}

export class OpenRouterProvider implements LLMProvider {
  readonly id: ProviderId = 'openrouter';
  readonly displayName = 'OpenRouter';
  readonly isLocal = false;

  private readonly apiKey: string;
  private readonly referer: string;

  constructor(apiKey: string, options?: OpenRouterOptions) {
    this.apiKey = apiKey;
    this.referer = options?.referer ?? 'https://github.com/VaidikV/OmniChat-VSCode-Extension';
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'HTTP-Referer': this.referer,
      'X-Title': 'OmniChat',
    };
  }

  async checkConnection(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/auth/key`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw err;
      }
      throw new OmniChatError('NETWORK_ERROR', this.id);
    }
    if (res.status === 401) {
      throw new OmniChatError('UNAUTHORIZED', this.id);
    }
    if (!res.ok) {
      throw new OmniChatError('NETWORK_ERROR', this.id, { status: String(res.status) });
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    // Public endpoint; no key needed.
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/models`, {
        signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw err;
      }
      throw new OmniChatError('NETWORK_ERROR', this.id);
    }
    if (!res.ok) {
      throw httpToError(res, this.id);
    }
    const data = (await res.json()) as {
      data?: Array<{
        id?: string;
        name?: string;
        context_length?: number;
        pricing?: { prompt?: string; completion?: string };
      }>;
    };
    return (data.data ?? []).map((m) => ({
      id: m.id ?? '',
      label: m.name ?? m.id ?? '',
      description: pricingHint(m.pricing),
      contextLength: m.context_length,
    }));
  }

  async *chatStream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/chat/completions`, {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: req.model, messages: req.messages, stream: true }),
        signal: req.signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw err;
      }
      throw new OmniChatError('NETWORK_ERROR', this.id);
    }
    if (!res.ok || !res.body) {
      // 402 (out of credits) maps to PAYMENT_REQUIRED here.
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
      throw new OmniChatError('NETWORK_ERROR', this.id);
    }
  }
}
