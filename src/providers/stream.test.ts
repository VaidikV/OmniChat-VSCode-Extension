/**
 * Unit tests for src/providers/stream.ts.
 * Run under plain node:test (no vscode, no Electron).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OmniChatError } from './errors.js';
import { readNdjson, readSse } from './stream.js';
import type { StreamEvent } from './types.js';

function streamFromChunks(chunks: Array<Uint8Array | string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const bytes = chunks.map((c) => (typeof c === 'string' ? encoder.encode(c) : c));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const b of bytes) {
        controller.enqueue(b);
      }
      controller.close();
    },
  });
}

/** A stream that never produces a chunk and never closes. */
function hangingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start() {} });
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) {
    events.push(e);
  }
  return events;
}

const ndjsonMapper = (chunk: unknown): StreamEvent | null => {
  const c = chunk as { text?: string };
  return typeof c.text === 'string' ? { type: 'token', text: c.text } : null;
};

const sseMapper = (data: string): StreamEvent | 'done' | null => {
  if (data.trim() === '[DONE]') {
    return 'done';
  }
  return { type: 'token', text: data };
};

describe('readNdjson', () => {
  it('parses lines and maps content', async () => {
    const body = streamFromChunks(['{"text":"a"}\n{"text":"b"}\n']);
    assert.deepEqual(await collect(readNdjson(body, ndjsonMapper)), [
      { type: 'token', text: 'a' },
      { type: 'token', text: 'b' },
    ]);
  });

  it('handles a JSON object split across chunks', async () => {
    const body = streamFromChunks(['{"tex', 't":"hel', 'lo"}\n']);
    assert.deepEqual(await collect(readNdjson(body, ndjsonMapper)), [
      { type: 'token', text: 'hello' },
    ]);
  });

  it('handles a trailing line without a newline', async () => {
    const body = streamFromChunks(['{"text":"tail"}']);
    assert.deepEqual(await collect(readNdjson(body, ndjsonMapper)), [
      { type: 'token', text: 'tail' },
    ]);
  });

  it('skips blank and malformed lines', async () => {
    const body = streamFromChunks(['\n{"text":"ok"}\nnot-json\n{"text":"ok2"}\n']);
    assert.deepEqual(await collect(readNdjson(body, ndjsonMapper)), [
      { type: 'token', text: 'ok' },
      { type: 'token', text: 'ok2' },
    ]);
  });
});

describe('readSse', () => {
  it('parses data lines and the [DONE] terminator', async () => {
    const body = streamFromChunks(['data: hello\n\ndata: [DONE]\n\n']);
    assert.deepEqual(await collect(readSse(body, sseMapper)), [
      { type: 'token', text: 'hello' },
      { type: 'done' },
    ]);
  });

  it('handles events split across chunks', async () => {
    const body = streamFromChunks(['data: hel', 'lo\n\ndata: [DO', 'NE]\n\n']);
    assert.deepEqual(await collect(readSse(body, sseMapper)), [
      { type: 'token', text: 'hello' },
      { type: 'done' },
    ]);
  });

  it('ignores comments and joins multi-line data with newlines', async () => {
    const body = streamFromChunks([': comment\n', 'data: line1\ndata: line2\n\n', 'data: [DONE]\n\n']);
    assert.deepEqual(await collect(readSse(body, sseMapper)), [
      { type: 'token', text: 'line1\nline2' },
      { type: 'done' },
    ]);
  });

  it('handles CRLF line endings', async () => {
    const body = streamFromChunks(['data: hi\r\n\r\ndata: [DONE]\r\n\r\n']);
    assert.deepEqual(await collect(readSse(body, sseMapper)), [
      { type: 'token', text: 'hi' },
      { type: 'done' },
    ]);
  });
});

describe('stall timeout', () => {
  it('throws OmniChatError TIMEOUT when no event arrives in time', async () => {
    const body = hangingStream();
    await assert.rejects(
      collect(readNdjson(body, ndjsonMapper, { stallTimeoutMs: 50, providerId: 'ollama' })),
      (err: unknown) => {
        assert.ok(err instanceof OmniChatError);
        assert.equal(err.code, 'TIMEOUT');
        assert.equal(err.providerId, 'ollama');
        return true;
      },
    );
  });

  it('resets the stall timer on each event', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('{"text":"a"}\n'));
        setTimeout(() => {
          controller.enqueue(encoder.encode('{"text":"b"}\n'));
          controller.close();
        }, 60);
      },
    });
    const events = await collect(readNdjson(body, ndjsonMapper, { stallTimeoutMs: 150 }));
    assert.deepEqual(events, [
      { type: 'token', text: 'a' },
      { type: 'token', text: 'b' },
    ]);
  });
});

describe('abort', () => {
  it('propagates an already-aborted signal as AbortError', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      collect(readSse(hangingStream(), sseMapper, { signal: controller.signal })),
      (err: unknown) => {
        assert.equal((err as Error).name, 'AbortError');
        return true;
      },
    );
  });

  it('aborts a hanging read mid-flight with AbortError', async () => {
    const controller = new AbortController();
    const pending = collect(
      readNdjson(hangingStream(), ndjsonMapper, { signal: controller.signal, stallTimeoutMs: 10_000 }),
    );
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, (err: unknown) => {
      assert.equal((err as Error).name, 'AbortError');
      return true;
    });
  });
});
