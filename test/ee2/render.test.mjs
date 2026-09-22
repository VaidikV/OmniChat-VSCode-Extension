import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// DOMPurify needs a DOM window; provide one before importing the bundle.
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;

const { renderMarkdown } = await import('./render.bundle.mjs');

test('basic markdown renders (headings, code blocks, tables)', () => {
  const out = renderMarkdown('# Hello\n\n```js\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
  assert.match(out, /<h1[^>]*>Hello<\/h1>/);
  assert.match(out, /<pre><code[^>]*>/);
  assert.match(out, /<table>/);
});

test('script tags and event handlers are stripped', () => {
  const out = renderMarkdown('<script>alert("xss")</script>\n\n<img src="x" onerror="alert(1)">\n\n[a](javascript:alert(1))');
  assert.doesNotMatch(out, /<script/i);
  assert.doesNotMatch(out, /onerror/i);
  assert.doesNotMatch(out, /javascript:/i);
});

test('think blocks become collapsed <details> elements', () => {
  const out = renderMarkdown('The answer is 42.\n\n<think>Let me reason about this carefully.</think>\n\nDone.');
  assert.match(out, /<details class="thinking">/);
  assert.match(out, /<summary>Thinking<\/summary>/);
  assert.match(out, /Let me reason about this carefully\./);
  // The visible answer text is still present outside the details block.
  assert.match(out, /The answer is 42\./);
  assert.doesNotMatch(out, /<think>/i);
});

test('multiple think blocks each become a details element', () => {
  const out = renderMarkdown('<think>first</think>\n\nmiddle\n\n<think>second</think>');
  assert.equal((out.match(/<details class="thinking">/g) || []).length, 2);
  assert.match(out, /middle/);
});

test('inline code and bold survive sanitization', () => {
  const out = renderMarkdown('Use `npm run build` for a **bold** move.');
  assert.match(out, /<code>npm run build<\/code>/);
  assert.match(out, /<strong>bold<\/strong>/);
});
