/**
 * Shared streaming readers for provider HTTP responses.
 *
 * Pure module: MUST NOT import 'vscode'. Unit-testable under plain node.
 *
 * Both readers:
 *  - consume a ReadableStream<Uint8Array> (e.g. fetch response.body),
 *  - are split-frame safe (a JSON line or SSE event may span chunks),
 *  - release the reader in a finally block,
 *  - throw OmniChatError('TIMEOUT', providerId) when no event is yielded
 *    within stallTimeoutMs (stall semantics: time without any token),
 *  - propagate user aborts as an AbortError (name === 'AbortError') so the
 *    orchestrator can swallow them silently as cancellation.
 */

import { OmniChatError } from './errors.js';
import type { ProviderId, StreamEvent } from './types.js';

export interface StreamOptions {
  /** User abort signal. Aborts propagate as AbortError. */
  signal?: AbortSignal;
  /**
   * Milliseconds without any yielded event before the stream is treated as
   * stalled and an OmniChatError('TIMEOUT') is thrown. Undefined disables
   * the stall watchdog.
   */
  stallTimeoutMs?: number;
  /** Provider id attached to the TIMEOUT error. */
  providerId?: ProviderId;
}

export type NdjsonMapper = (chunk: unknown) => StreamEvent | null;

/**
 * Maps one SSE `data:` payload to an event. Return the literal string
 * 'done' to end the stream with a { type: 'done' } event (e.g. the
 * OpenAI-style `[DONE]` terminator).
 */
export type SseMapper = (data: string) => StreamEvent | 'done' | null;

/** Build an AbortError without relying on the (optional) signal reason. */
function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof DOMException && err.name === 'AbortError'
  ) || (
    typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * Await a reader.read() promise, losing to either the user abort signal
 * or the stall watchdog, whichever fires first.
 */
function raceRead(
  readPromise: Promise<ReadableStreamReadResult<Uint8Array>>,
  options: StreamOptions | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const signal = options?.signal;
  const stallMs = options?.stallTimeoutMs;
  const providerId = options?.providerId;

  if (signal?.aborted) {
    return Promise.reject(abortError());
  }
  if (stallMs === undefined && !signal) {
    return readPromise;
  }

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (stallMs !== undefined) {
      timer = setTimeout(() => {
        cleanup();
        // If the user aborted at the same moment, cancellation wins.
        if (signal?.aborted) {
          reject(abortError());
        } else {
          reject(new OmniChatError('TIMEOUT', providerId));
        }
      }, stallMs);
    }
    readPromise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}

/** Raw byte iterator over the body with abort/stall handling. */
async function* readBytes(
  body: ReadableStream<Uint8Array>,
  options?: StreamOptions,
): AsyncGenerator<Uint8Array> {
  if (options?.signal?.aborted) {
    throw abortError();
  }
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await raceRead(reader.read(), options);
      if (done) {
        return;
      }
      yield value;
    }
  } finally {
    // Settle any in-flight read() before releasing the lock; otherwise
    // releaseLock() throws "Invalid state: Releasing reader".
    try {
      await reader.cancel();
    } catch {
      // Stream already closed or errored; nothing to cancel.
    }
    reader.releaseLock();
  }
}

/**
 * Read NDJSON (one JSON object per line, e.g. Ollama /api/chat).
 * Malformed lines are skipped. The mapper translates a parsed object to a
 * StreamEvent, or returns null to ignore the line.
 */
export async function* readNdjson(
  body: ReadableStream<Uint8Array>,
  mapper: NdjsonMapper,
  options?: StreamOptions,
): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const bytes of readBytes(body, options)) {
    buffer += decoder.decode(bytes, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const event = parseNdjsonLine(line, mapper);
      if (event) {
        yield event;
      }
    }
  }
  const tail = (buffer + decoder.decode()).trim();
  if (tail) {
    const event = parseNdjsonLine(tail, mapper);
    if (event) {
      yield event;
    }
  }
}

function parseNdjsonLine(line: string, mapper: NdjsonMapper): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return mapper(parsed);
}

const SSE_EVENT_BOUNDARY = /\r?\n\r?\n/;

/**
 * Read Server-Sent Events (e.g. OpenAI /v1/chat/completions with
 * stream: true). Splits on blank lines, collects `data:` lines
 * (multiple data lines are joined with '\n'), ignores comments and other
 * fields. The mapper translates one data payload to an event, the literal
 * 'done' to terminate, or null to ignore.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  mapper: SseMapper,
  options?: StreamOptions,
): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  const dataLines: string[] = [];

  const dispatch = (): StreamEvent | 'done' | null => {
    if (dataLines.length === 0) {
      return null;
    }
    const data = dataLines.join('\n');
    dataLines.length = 0;
    return mapper(data);
  };

  const emit = function* (): Generator<StreamEvent | 'done-marker'> {
    const event = dispatch();
    if (event === 'done') {
      yield 'done-marker';
    } else if (event) {
      yield event;
    }
  };

  for await (const bytes of readBytes(body, options)) {
    buffer += decoder.decode(bytes, { stream: true });
    let boundary = buffer.match(SSE_EVENT_BOUNDARY);
    while (boundary?.index !== undefined) {
      const eventText = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      for (const line of eventText.split(/\r?\n/)) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
      for (const event of emit()) {
        if (event === 'done-marker') {
          yield { type: 'done' };
          return;
        }
        yield event;
      }
      boundary = buffer.match(SSE_EVENT_BOUNDARY);
    }
  }

  // Trailing event not terminated by a blank line.
  const tail = (buffer + decoder.decode()).trim();
  if (tail) {
    for (const line of tail.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  }
  for (const event of emit()) {
    if (event === 'done-marker') {
      yield { type: 'done' };
      return;
    }
    yield event;
  }
}
