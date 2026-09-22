/**
 * Unit tests for src/providers/ollama.ts with a mocked global fetch.
 * Run under plain node:test (no vscode, no Electron, no real network).
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OllamaProvider } from './ollama.js';
import { OmniChatError } from './errors.js';
import type { StreamEvent } from './types.js';

interface CapturedRequest {
  url: string;
  init?: RequestInit;
}

function installFetchMock(
  handler: (req: CapturedRequest) => Response | Promise<Response>,
): { requests: CapturedRequest[]; restore: () => void } {
  const requests: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const req = { url, init };
    requests.push(req);
    return handler(req);
  }) as typeof fetch;
  return { requests, restore: () => { globalThis.fetch = original; } };
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

function mockFetch(
  handler: (req: CapturedRequest) => Response | Promise<Response>,
): CapturedRequest[] {
  const m = installFetchMock(handler);
  restore = m.restore;
  return m.requests;
}

function streamBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(c));
      }
      controller.close();
    },
  });
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) {
    out.push(e);
  }
  return out;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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

describe('OllamaProvider', () => {
  it('strips trailing slashes from the base URL', () => {
    assert.equal(new OllamaProvider('http://127.0.0.1:11434///').baseUrl, 'http://127.0.0.1:11434');
  });

  it('checkConnection hits /api/version and succeeds on 200', async () => {
    const requests = mockFetch(() => jsonResponse({ version: '0.9.0' }));
    await new OllamaProvider('http://127.0.0.1:11434').checkConnection();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'http://127.0.0.1:11434/api/version');
  });

  it('checkConnection throws OLLAMA_UNREACHABLE when the server is down', async () => {
    mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    const err = await captureRejection(
      new OllamaProvider('http://127.0.0.1:11434').checkConnection(),
  ) as OmniChatError;
    assert.equal(err.code, 'OLLAMA_UNREACHABLE');
    assert.equal(err.providerId, 'ollama');
    assert.equal(err.detail?.baseUrl, 'http://127.0.0.1:11434');
  });

  it('checkConnection throws OLLAMA_UNREACHABLE on a non-OK status', async () => {
    mockFetch(() => new Response(null, { status: 500 }));
    const err = await captureRejection(
      new OllamaProvider('http://127.0.0.1:11434').checkConnection(),
  ) as OmniChatError;
    assert.equal(err.code, 'OLLAMA_UNREACHABLE');
  });

  it('listModels maps /api/tags to ModelInfo entries', async () => {
    mockFetch(() => jsonResponse({ models: [{ name: 'qwen3:8b', size: 1024 }] }));
    const models = await new OllamaProvider('http://127.0.0.1:11434').listModels();
    assert.equal(models.length, 1);
    assert.equal(models[0].id, 'qwen3:8b');
    assert.equal(models[0].label, 'qwen3:8b');
    assert.equal(models[0].description, '1.0 KB');
  });

  it('listModels returns an empty array when no models are installed', async () => {
    mockFetch(() => jsonResponse({ models: [] }));
    const models = await new OllamaProvider('http://127.0.0.1:11434').listModels();
    assert.deepEqual(models, []);
  });

  it('chatStream POSTs stream:true and yields tokens then done', async () => {
    const requests = mockFetch(() =>
      new Response(
        streamBody([
          '{"message":{"content":"Hello"}}\n',
          '{"message":{"content":" there"}}\n',
          '{"done":true,"prompt_eval_count":3,"eval_count":2}\n',
        ]),
        { status: 200 },
      ),
    );
    const events = await collect(
      new OllamaProvider('http://127.0.0.1:11434').chatStream({
        model: 'qwen3:8b',
        messages: [{ role: 'user', content: 'Hi' }],
        signal: new AbortController().signal,
      }),
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'http://127.0.0.1:11434/api/chat');
    assert.equal(requests[0].init?.method, 'POST');
    const body = JSON.parse(String(requests[0].init?.body));
    assert.equal(body.model, 'qwen3:8b');
    assert.equal(body.stream, true);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'Hi' }]);
    assert.deepEqual(events, [
      { type: 'token', text: 'Hello' },
      { type: 'token', text: ' there' },
      { type: 'done', promptTokens: 3, completionTokens: 2 },
    ]);
  });

  it('chatStream maps a 404 to MODEL_NOT_INSTALLED', async () => {
    mockFetch(() => new Response(null, { status: 404 }));
    const err = await captureRejection(
      collect(
        new OllamaProvider('http://127.0.0.1:11434').chatStream({
          model: 'missing:1b',
          messages: [{ role: 'user', content: 'Hi' }],
          signal: new AbortController().signal,
        }),
      ),
  ) as OmniChatError;
    assert.equal(err.code, 'MODEL_NOT_INSTALLED');
  });

  it('chatStream rethrows abort errors instead of wrapping them', async () => {
    mockFetch(() => {
      throw new DOMException('This operation was aborted', 'AbortError');
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      collect(
        new OllamaProvider('http://127.0.0.1:11434').chatStream({
          model: 'qwen3:8b',
          messages: [{ role: 'user', content: 'Hi' }],
          signal: controller.signal,
        }),
      ),
      (err: unknown) => err instanceof DOMException && err.name === 'AbortError',
    );
  });

  it('pullModel reports progress through the callback', async () => {
    const requests = mockFetch(() =>
      new Response(
        streamBody([
          '{"status":"pulling manifest","completed":0,"total":1000}\n',
          '{"status":"pulling blob","completed":1000,"total":1000}\n',
          '{"status":"success"}\n',
        ]),
        { status: 200 },
      ),
    );
    const progress: Array<{ completed: number; total: number; status: string }> = [];
    await new OllamaProvider('http://127.0.0.1:11434').pullModel(
      'qwen3:8b',
      (p) => progress.push(p),
      new AbortController().signal,
    );
    assert.equal(requests[0].url, 'http://127.0.0.1:11434/api/pull');
    assert.equal(requests[0].init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
      model: 'qwen3:8b',
      stream: true,
    });
    assert.deepEqual(progress, [
      { completed: 0, total: 1000, status: 'pulling manifest' },
      { completed: 1000, total: 1000, status: 'pulling blob' },
      { completed: 0, total: 0, status: 'success' },
    ]);
  });

  it('pullModel maps an error line to PULL_FAILED', async () => {
    mockFetch(() =>
      new Response(streamBody(['{"error":"disk full"}\n']), { status: 200 }),
    );
    const err = (await captureRejection(
      new OllamaProvider('http://127.0.0.1:11434').pullModel(
        'qwen3:8b',
        () => undefined,
        new AbortController().signal,
      ),
    )) as OmniChatError;
    assert.equal(err.code, 'PULL_FAILED');
  });

  it('pullModel maps a 404 to MODEL_NOT_FOUND', async () => {
    mockFetch(() => new Response(null, { status: 404 }));
    const err = (await captureRejection(
      new OllamaProvider('http://127.0.0.1:11434').pullModel(
        'nope:1b',
        () => undefined,
        new AbortController().signal,
      ),
    )) as OmniChatError;
    assert.equal(err.code, 'MODEL_NOT_FOUND');
  });
});
