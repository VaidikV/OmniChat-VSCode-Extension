/**
 * Markdown rendering for the webview. Pure module: MUST NOT import 'vscode'.
 *
 * - Renders with marked (gfm, breaks), then sanitizes with DOMPurify
 *   (USE_PROFILES { html: true }).
 * - <think>...</think> blocks (reasoning models) are extracted BEFORE
 *   markdown parsing and rendered as collapsed <details> elements, so
 *   reasoning content never flows through the markdown path as answer text.
 * - Makes zero network calls; safe to bundle into the CSP-locked webview.
 */
// @ts-expect-error TS1479: marked is ESM-only. This file ships through the
// esbuild webview bundle (which resolves ESM fine); tsc's CJS emit for
// webview-src is never loaded, so the require() form tsc complains about
// never executes.
import { marked } from 'marked';
import createDOMPurify, { type WindowLike } from 'dompurify';

type Purifier = ReturnType<typeof createDOMPurify>;

let cachedPurifier: Purifier | null = null;

function getPurifier(): Purifier {
  if (!cachedPurifier) {
    const w = (globalThis as unknown as { window?: Window }).window;
    if (!w || !w.document) {
      throw new Error('renderMarkdown requires a DOM window');
    }
    // The DOM lib's Window type does not declare the constructor globals
    // DOMPurify's WindowLike needs, although they exist at runtime.
    cachedPurifier = createDOMPurify(w as unknown as WindowLike);
  }
  return cachedPurifier;
}

function sanitize(dirty: string): string {
  return getPurifier().sanitize(dirty, { USE_PROFILES: { html: true } });
}

function parseMarkdown(md: string): string {
  return marked.parse(md, { breaks: true, gfm: true }) as string;
}

const THINK_RE = /<think>([\s\S]*?)<\/think>/g;

function renderThinkBlock(body: string): string {
  const inner = sanitize(parseMarkdown(body.trim()));
  return (
    '<details class="thinking"><summary>Thinking</summary>' +
    `<div class="thinking-content">${inner}</div></details>`
  );
}

/**
 * Render markdown to sanitized HTML. <think> blocks become collapsed
 * <details> elements; everything else goes through marked + DOMPurify.
 */
export function renderMarkdown(md: string): string {
  const parts: string[] = [];
  let last = 0;
  THINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = THINK_RE.exec(md)) !== null) {
    if (m.index > last) {
      parts.push(sanitize(parseMarkdown(md.slice(last, m.index))));
    }
    parts.push(renderThinkBlock(m[1]));
    last = m.index + m[0].length;
  }
  if (last < md.length) {
    parts.push(sanitize(parseMarkdown(md.slice(last))));
  }
  return parts.join('');
}
