/**
 * Unit tests for src/providers/openrouter.ts with a mocked global fetch.
 * Run under plain node:test (no vscode, no Electron, no real network).
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterProvider, pricingHint } from './openrouter.js';
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
  const h = req.init?.headers as Record<string, string> | undefined;
  return h ?? {};
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

describe('OpenRouterProvider', () => {
  it('checkConnection sends the Bearer key to /auth/key', async () => {
    const requests = mockFetch(() => jsonResponse({ data: { label: 'k' } }));
    await new OpenRouterProvider('sk-test-key').checkConnection();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/auth/key');
    assert.equal(headersOf(requests[0]).Authorization, 'Bearer sk-test-key');
  });

  it('checkConnection maps a 401 to UNAUTHORIZED', async () => {
    mockFetch(() => new Response(null, { status: 401 }));
    const err = await captureRejection(
      new OpenRouterProvider('sk-bad-key').checkConnection(),
  ) as OmniChatError;
    assert.equal(err.code, 'UNAUTHORIZED');
    assert.equal(err.providerId, 'openrouter');
  });

  it('checkConnection maps a network failure to NETWORK_ERROR', async () => {
    mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    const err = await captureRejection(
      new OpenRouterProvider('sk-test-key').checkConnection(),
  ) as OmniChatError;
    assert.equal(err.code, 'NETWORK_ERROR');
  });

  it('checkConnection maps a non-401 failure status to NETWORK_ERROR', async () => {
    mockFetch(() => new Response(null, { status: 503 }));
    const err = (await captureRejection(
      new OpenRouterProvider('sk-test-key').checkConnection(),
    )) as OmniChatError;
    assert.equal(err.code, 'NETWORK_ERROR');
  });

  it('the API key never appears in error details', async () => {
    mockFetch(() => new Response(null, { status: 401 }));
    const err = await captureRejection(
      new OpenRouterProvider('sk-super-secret').checkConnection(),
  ) as OmniChatError;
    assert.ok(!JSON.stringify(err).includes('sk-super-secret'));
  });

  it('listModels maps pricing hints and context length without a key', async () => {
    const requests = mockFetch(() =>
      jsonResponse({
        data: [
          {
            id: 'openai/gpt-oss-20b',
            name: 'GPT OSS 20B',
            context_length: 131072,
            pricing: { prompt: '0', completion: '0' },
          },
          {
            id: 'anthropic/claude-x',
            name: 'Claude X',
            context_length: 200000,
            pricing: { prompt: '0.000003', completion: '0.000015' },
          },
        ],
      }),
    );
    const models = await new OpenRouterProvider('sk-test-key').listModels();
    assert.equal(models.length, 2);
    assert.equal(models[0].id, 'openai/gpt-oss-20b');
    assert.equal(models[0].description, 'Free');
    assert.equal(models[0].contextLength, 131072);
    assert.ok(models[1].description?.includes('/1M in'));
    // The public /models endpoint is keyless.
    assert.ok(!('Authorization' in headersOf(requests[0])));
  });

  it('chatStream yields SSE tokens then done', async () => {
    const requests = mockFetch(() =>
      new Response(
        streamBody([
          'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );
    const events = await collect(
      new OpenRouterProvider('sk-test-key').chatStream({
        model: 'openai/gpt-oss-20b',
        messages: [{ role: 'user', content: 'Hi' }],
        signal: new AbortController().signal,
      }),
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(requests[0].init?.method, 'POST');
    assert.equal(headersOf(requests[0]).Authorization, 'Bearer sk-test-key');
    const body = JSON.parse(String(requests[0].init?.body));
    assert.equal(body.model, 'openai/gpt-oss-20b');
    assert.equal(body.stream, true);
    assert.deepEqual(events, [
      { type: 'token', text: 'Hello' },
      { type: 'token', text: ' world' },
      { type: 'done' },
    ]);
  });

  it('chatStream maps a 402 to PAYMENT_REQUIRED', async () => {
    mockFetch(() => new Response(null, { status: 402 }));
    const err = await captureRejection(
      collect(
        new OpenRouterProvider('sk-test-key').chatStream({
          model: 'openai/gpt-oss-20b',
          messages: [{ role: 'user', content: 'Hi' }],
          signal: new AbortController().signal,
        }),
      ),
  ) as OmniChatError;
    assert.equal(err.code, 'PAYMENT_REQUIRED');
  });

  it('chatStream maps a 404 to MODEL_NOT_FOUND', async () => {
    mockFetch(() => new Response(null, { status: 404 }));
    const err = await captureRejection(
      collect(
        new OpenRouterProvider('sk-test-key').chatStream({
          model: 'nope/model',
          messages: [{ role: 'user', content: 'Hi' }],
          signal: new AbortController().signal,
        }),
      ),
  ) as OmniChatError;
    assert.equal(err.code, 'MODEL_NOT_FOUND');
  });
});

describe('pricingHint', () => {
  it('returns Free for zero pricing', () => {
    assert.equal(pricingHint({ prompt: '0', completion: '0' }), 'Free');
  });

  it('returns undefined for missing or invalid pricing', () => {
    assert.equal(pricingHint(undefined), undefined);
    assert.equal(pricingHint({ prompt: 'abc', completion: '0' }), undefined);
  });
});
