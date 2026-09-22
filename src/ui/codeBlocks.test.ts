/**
 * Unit tests for the fenced code block parser (FR-17).
 * Plain node:test; no 'vscode' import anywhere in this file or its target.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { codeBlockLabel, parseCodeBlocks } from './codeBlocks.js';

describe('parseCodeBlocks', () => {
  it('returns no blocks for plain prose', () => {
    assert.deepEqual(parseCodeBlocks('Just some text.\nNo fences here.'), []);
  });

  it('extracts a single block with its language', () => {
    const blocks = parseCodeBlocks('Here:\n```python\nprint("hi")\n```\nDone.');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].language, 'python');
    assert.equal(blocks[0].code, 'print("hi")');
  });

  it('keeps response order for multiple blocks', () => {
    const md = '```js\nconst a = 1;\n```\ntext\n```ts\nconst b: number = 2;\n```';
    const blocks = parseCodeBlocks(md);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].language, 'js');
    assert.equal(blocks[0].code, 'const a = 1;');
    assert.equal(blocks[1].language, 'ts');
  });

  it('handles fences without a language tag', () => {
    const blocks = parseCodeBlocks('```\nplain\n```');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].language, '');
    assert.equal(blocks[0].code, 'plain');
  });

  it('keeps interior blank lines verbatim, strips one trailing newline', () => {
    const blocks = parseCodeBlocks('```py\nline1\n\nline2\n```');
    assert.equal(blocks[0].code, 'line1\n\nline2');
  });

  it('ignores unclosed fences', () => {
    assert.deepEqual(parseCodeBlocks('```py\nnever closed'), []);
  });
});

describe('codeBlockLabel', () => {
  it('numbers from 1 and falls back to "code"', () => {
    assert.equal(codeBlockLabel(0, { language: 'rust', code: '' }), '1. rust');
    assert.equal(codeBlockLabel(2, { language: '', code: '' }), '3. code');
  });
});
