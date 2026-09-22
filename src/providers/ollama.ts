/**
 * Ollama provider implemented on raw fetch (REST + NDJSON streaming).
 *
 * Decision #13: no `ollama` npm dependency; uniform AbortSignal cancellation.
 * This module avoids importing 'vscode' so it stays testable under plain node.
 */

import { execFile, spawn } from 'node:child_process';
import { OmniChatError, httpToError } from './errors.js';
import { isAbortError, readNdjson } from './stream.js';
import type {
  ChatRequest,
  LLMProvider,
  ModelInfo,
  ProviderId,
  PullProgress,
  StreamEvent,
} from './types.js';
import { DEFAULT_STALL_TIMEOUT_MS } from './types.js';

const VERSION_TIMEOUT_MS = 5_000;
const START_POLL_TIMEOUT_MS = 15_000;
const START_POLL_INTERVAL_MS = 500;

/** Strip trailing slashes so endpoint joins are predictable. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function toModelInfo(m: { name?: string; size?: number }): ModelInfo {
  const id = m.name ?? '';
  const size = typeof m.size === 'number' ? formatBytes(m.size) : '';
  return { id, label: id, description: size || undefined };
}

export class OllamaProvider implements LLMProvider {
  readonly id: ProviderId = 'ollama';
  readonly displayName = 'Ollama';
  readonly isLocal = true;
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async checkConnection(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/version`, {
        signal: AbortSignal.timeout(VERSION_TIMEOUT_MS),
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw err;
      }
      // ECONNREFUSED, DNS failure, or the 5s timeout.
      throw new OmniChatError('OLLAMA_UNREACHABLE', this.id, { baseUrl: this.baseUrl });
    }
    if (!res.ok) {
      throw new OmniChatError('OLLAMA_UNREACHABLE', this.id, { baseUrl: this.baseUrl });
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(VERSION_TIMEOUT_MS),
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw err;
      }
      throw new OmniChatError('OLLAMA_UNREACHABLE', this.id, { baseUrl: this.baseUrl });
    }
    if (!res.ok) {
      throw new OmniChatError('OLLAMA_UNREACHABLE', this.id, { baseUrl: this.baseUrl });
    }
    const data = (await res.json()) as { models?: Array<{ name?: string; size?: number }> };
    return (data.models ?? []).map(toModelInfo);
  }

  async *chatStream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: req.model, messages: req.messages, stream: true }),
        signal: req.signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw err;
      }
      throw new OmniChatError('OLLAMA_UNREACHABLE', this.id, { baseUrl: this.baseUrl });
    }
    if (!res.ok || !res.body) {
      throw httpToError(res, this.id, 'MODEL_NOT_INSTALLED');
    }
    try {
      yield* readNdjson(
        res.body,
        (chunk) => {
          const c = chunk as {
            message?: { content?: string; thinking?: string };
            done?: boolean;
            prompt_eval_count?: number;
            eval_count?: number;
          };
          if (c.message?.content) {
            return { type: 'token', text: c.message.content };
          }
          if (c.message?.thinking) {
            return { type: 'reasoning', text: c.message.thinking };
          }
          if (c.done) {
            return {
              type: 'done',
              promptTokens: c.prompt_eval_count,
              completionTokens: c.eval_count,
            };
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
      throw new OmniChatError('OLLAMA_UNREACHABLE', this.id, { baseUrl: this.baseUrl });
    }
  }

  async pullModel(
    model: string,
    onProgress: (p: PullProgress) => void,
    signal: AbortSignal,
  ): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: true }),
        signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw err;
      }
      throw new OmniChatError('OLLAMA_UNREACHABLE', this.id, { baseUrl: this.baseUrl });
    }
    if (!res.ok || !res.body) {
      throw httpToError(res, this.id, 'MODEL_NOT_FOUND');
    }
    try {
      for await (const _ of readNdjson(
        res.body,
        (chunk) => {
          const c = chunk as {
            status?: string;
            completed?: number;
            total?: number;
            error?: string;
          };
          if (c.error) {
            throw new OmniChatError('PULL_FAILED', this.id, { model, detail: c.error });
          }
          onProgress({
            completed: typeof c.completed === 'number' ? c.completed : 0,
            total: typeof c.total === 'number' ? c.total : 0,
            status: c.status ?? '',
          });
          return null;
        },
        { signal, providerId: this.id },
      )) {
        // Progress is delivered via the callback; nothing to yield.
      }
    } catch (err) {
      if (isAbortError(err) || err instanceof OmniChatError) {
        throw err;
      }
      throw new OmniChatError('PULL_FAILED', this.id, { model });
    }
  }
}

// ---------------------------------------------------------------------------
// Detection helpers for the setup wizard (host side, EE-3).
// ---------------------------------------------------------------------------

/**
 * PATH lookup for the `ollama` binary. No shell string interpolation:
 * `command -v ollama` on macOS/Linux, `where ollama` on Windows.
 */
export function isOllamaInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'where' : 'command';
    const args = process.platform === 'win32' ? ['ollama'] : ['-v', 'ollama'];
    execFile(cmd, args, (err) => {
      resolve(!err);
    });
  });
}

export interface OllamaStatus {
  running: boolean;
  version?: string;
}

/** Probe /api/version; never throws, reports running/not-running. */
export async function checkOllamaStatus(baseUrl: string): Promise<OllamaStatus> {
  const base = normalizeBaseUrl(baseUrl);
  try {
    const res = await fetch(`${base}/api/version`, {
      signal: AbortSignal.timeout(VERSION_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { running: false };
    }
    const data = (await res.json()) as { version?: string };
    return { running: true, version: data.version };
  } catch {
    return { running: false };
  }
}

/** Installed models at baseUrl; empty array on any failure (detection path). */
export async function getOllamaModels(baseUrl: string): Promise<ModelInfo[]> {
  try {
    return await new OllamaProvider(baseUrl).listModels();
  } catch {
    return [];
  }
}

/**
 * Start Ollama (explicit user click only, decision #27): spawn
 * `ollama serve` detached, then poll /api/version for ~15s.
 * Throws OmniChatError('OLLAMA_START_FAILED') when it does not come up.
 */
export async function startOllama(baseUrl: string): Promise<void> {
  const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' });
  child.unref();
  await new Promise<void>((resolve, reject) => {
    child.once('error', (err) => {
      reject(
        new OmniChatError('OLLAMA_START_FAILED', 'ollama', { detail: err.message }),
      );
    });
    child.once('spawn', () => {
      resolve();
    });
  });
  await waitForOllama(baseUrl, START_POLL_TIMEOUT_MS);
}

/** Poll /api/version until it responds or the timeout elapses. */
export async function waitForOllama(baseUrl: string, timeoutMs: number): Promise<void> {
  const base = normalizeBaseUrl(baseUrl);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/version`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) {
        return;
      }
    } catch {
      // Not up yet.
    }
    if (Date.now() >= deadline) {
      throw new OmniChatError('OLLAMA_START_FAILED', 'ollama', { baseUrl: base });
    }
    await new Promise((r) => setTimeout(r, START_POLL_INTERVAL_MS));
  }
}
