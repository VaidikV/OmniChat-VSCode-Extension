/**
 * Unit tests for src/providers/genericOpenAI.ts with a mocked global fetch.
 * Run under plain node:test (no vscode, no Electron, no real network).
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GenericOpenAICompatibleProvider, normalizeBaseUrl } from './genericOpenAI.js';
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

function headersOf(req: CapturedRequest): Record<string, string> {
  return (req.init?.headers as Record<string, string> | undefined) ?? {};
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

describe('normalizeBaseUrl', () => {
  it('adds a missing /v1 suffix', () => {
    assert.equal(normalizeBaseUrl('http://localhost:1234'), 'http://localhost:1234/v1');
  });

  it('strips trailing slashes and keeps an existing /v1', () => {
    assert.equal(normalizeBaseUrl('http://localhost:1234/v1///'), 'http://localhost:1234/v1');
  });
});

describe('GenericOpenAICompatibleProvider', () => {
  it('checkConnection probes /models and succeeds on 200', async () => {
    const requests = mockFetch(() => jsonResponse({ data: [] }));
    await new GenericOpenAICompatibleProvider('http://localhost:1234').checkConnection();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'http://localhost:1234/v1/models');
  });

  it('checkConnection maps a 401 to UNAUTHORIZED', async () => {
    mockFetch(() => new Response(null, { status: 401 }));
    const err = await captureRejection(
      new GenericOpenAICompatibleProvider('http://localhost:1234', 'key').checkConnection(),
  ) as OmniChatError;
    assert.equal(err.code, 'UNAUTHORIZED');
    assert.equal(err.providerId, 'custom');
  });

  it('checkConnection maps a refused connection to NETWORK_ERROR with the URL', async () => {
    mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    const err = await captureRejection(
      new GenericOpenAICompatibleProvider('http://localhost:1234').checkConnection(),
  ) as OmniChatError;
    assert.equal(err.code, 'NETWORK_ERROR');
    assert.equal(err.detail?.baseUrl, 'http://localhost:1234/v1');
  });

  it('checkConnection maps a non-401 failure status to NETWORK_ERROR', async () => {
    mockFetch(() => new Response(null, { status: 500 }));
    const err = (await captureRejection(
      new GenericOpenAICompatibleProvider('http://localhost:1234').checkConnection(),
    )) as OmniChatError;
    assert.equal(err.code, 'NETWORK_ERROR');
    assert.equal(err.detail?.baseUrl, 'http://localhost:1234/v1');
  });

  it('listModels maps the /models payload', async () => {
    mockFetch(() =>
      jsonResponse({ data: [{ id: 'llama-3.1-8b' }, { id: 'qwen-2.5' }] }),
    );
    const models = await new GenericOpenAICompatibleProvider(
      'http://localhost:1234',
    ).listModels();
    assert.deepEqual(models.map((m) => m.id), ['llama-3.1-8b', 'qwen-2.5']);
  });

  it('listModels falls back to the configured default model on failure', async () => {
    mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    const models = await new GenericOpenAICompatibleProvider('http://localhost:1234', undefined, {
      defaultModel: 'my-model',
    }).listModels();
    assert.equal(models.length, 1);
    assert.equal(models[0].id, 'my-model');
  });

  it('listModels returns an empty array with no default model and no list', async () => {
    mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    const models = await new GenericOpenAICompatibleProvider(
      'http://localhost:1234',
    ).listModels();
    assert.deepEqual(models, []);
  });

  it('chatStream sends the Bearer key when one is configured', async () => {
    const requests = mockFetch(() =>
      new Response(streamBody(['data: [DONE]\n\n']), { status: 200 }),
    );
    const events = await collect(
      new GenericOpenAICompatibleProvider('http://localhost:1234', 'secret').chatStream({
        model: 'm',
        messages: [{ role: 'user', content: 'Hi' }],
        signal: new AbortController().signal,
      }),
    );
    assert.equal(requests[0].url, 'http://localhost:1234/v1/chat/completions');
    assert.equal(headersOf(requests[0]).Authorization, 'Bearer secret');
    assert.deepEqual(events, [{ type: 'done' }]);
  });

  it('chatStream omits the Authorization header without a key', async () => {
    const requests = mockFetch(() =>
      new Response(
        streamBody(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']),
        { status: 200 },
      ),
    );
    const events = await collect(
      new GenericOpenAICompatibleProvider('http://localhost:1234').chatStream({
        model: 'm',
        messages: [{ role: 'user', content: 'Hi' }],
        signal: new AbortController().signal,
      }),
    );
    assert.ok(!('Authorization' in headersOf(requests[0])));
    assert.deepEqual(events, [{ type: 'token', text: 'ok' }, { type: 'done' }]);
  });

  it('chatStream maps a 404 to MODEL_NOT_FOUND', async () => {
    mockFetch(() => new Response(null, { status: 404 }));
    const err = await captureRejection(
      collect(
        new GenericOpenAICompatibleProvider('http://localhost:1234').chatStream({
          model: 'nope',
          messages: [{ role: 'user', content: 'Hi' }],
          signal: new AbortController().signal,
        }),
      ),
  ) as OmniChatError;
    assert.equal(err.code, 'MODEL_NOT_FOUND');
  });
});
