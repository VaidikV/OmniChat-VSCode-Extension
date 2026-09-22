/**
 * Fenced code block parsing for FR-17 (Insert at cursor).
 *
 * Pure module: MUST NOT import 'vscode'. The ChatOrchestrator parses the
 * latest completed assistant response with parseCodeBlocks() and offers the
 * blocks for insertion at the editor cursor.
 */

export interface CodeBlock {
  /** Language id from the fence info string, '' when the fence has none. */
  language: string;
  /** Raw code between the fences (no fence markers). */
  code: string;
}

const FENCE_RE = /```([^\s`\n]*)[ \t]*\n([\s\S]*?)```/g;

/**
 * Extract fenced code blocks from markdown text, in response order.
 * The language falls back to '' (the UI renders it as "code").
 * One trailing newline of the block body is stripped; interior content is
 * kept verbatim so insertion reproduces the code exactly.
 */
export function parseCodeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(markdown)) !== null) {
    blocks.push({
      language: (match[1] ?? '').trim(),
      code: (match[2] ?? '').replace(/\n$/, ''),
    });
  }
  return blocks;
}

/** QuickPick label for a block: "<n>. <language id>", "code" fallback. */
export function codeBlockLabel(index: number, block: CodeBlock): string {
  return `${index + 1}. ${block.language || 'code'}`;
}
