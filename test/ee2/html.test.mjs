import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildChatHtml, buildWelcomeHtml } = await import('./html.bundle.mjs');

const opts = {
  nonce: 'TESTNONCE123',
  cspSource: 'vscode-webview://9f2c1a',
  scriptUri: 'vscode-webview://9f2c1a/media/webview/bundle.js',
  styleUri: 'vscode-webview://9f2c1a/media/webview/bundle.css',
};

const EXPECTED_CSP =
  "default-src 'none'; script-src 'nonce-TESTNONCE123'; style-src 'nonce-TESTNONCE123'; " +
  'img-src vscode-webview://9f2c1a data:; font-src vscode-webview://9f2c1a; connect-src \'none\'';

for (const [name, html] of [['chat', buildChatHtml(opts)], ['welcome', buildWelcomeHtml(opts)]]) {
  test(`${name}: exact CSP policy with connect-src 'none'`, () => {
    assert.ok(html.includes(EXPECTED_CSP), 'CSP meta content mismatch');
    assert.ok(html.includes("connect-src 'none'"));
    assert.ok(html.includes("script-src 'nonce-TESTNONCE123'"));
    assert.ok(html.includes("style-src 'nonce-TESTNONCE123'"));
    assert.ok(html.includes('img-src vscode-webview://9f2c1a data:'));
    assert.ok(html.includes('font-src vscode-webview://9f2c1a;'));
    assert.ok(html.includes("default-src 'none'"));
  });

  test(`${name}: the passed nonce is applied to script and style tags`, () => {
    assert.ok(html.includes('nonce="TESTNONCE123"'));
    assert.ok(html.includes(`src="${opts.scriptUri}"`));
    assert.ok(html.includes(`href="${opts.styleUri}"`));
  });

  test(`${name}: no inline <script> or <style> blocks`, () => {
    assert.ok(!html.includes('<style'), 'found inline <style');
    // every <script> must carry a src attribute (no inline script bodies)
    const scripts = html.match(/<script[^>]*>/g) || [];
    assert.ok(scripts.length > 0, 'expected at least one script tag');
    for (const tag of scripts) {
      assert.ok(/src="/.test(tag), `inline script tag: ${tag}`);
      assert.ok(/nonce="TESTNONCE123"/.test(tag), `script tag missing nonce: ${tag}`);
    }
  });

  test(`${name}: no http(s) URLs in src/href`, () => {
    assert.ok(!/src="https?:\/\//.test(html));
    assert.ok(!/href="https?:\/\//.test(html));
  });
}

test('chat html contains the DOM hooks main.ts expects', () => {
  const html = buildChatHtml(opts);
  for (const id of ['currentModel', 'privacyLine', 'setupCta', 'chatMessages', 'prompt', 'askBtn', 'stopBtn']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
});

test('welcome html contains the welcome root', () => {
  const welcomeOpts = { ...opts, scriptUri: 'vscode-webview://9f2c1a/media/webview/welcome.js' };
  const html = buildWelcomeHtml(welcomeOpts);
  assert.ok(html.includes('id="welcomeRoot"'));
  assert.ok(html.includes('welcome.js'));
  assert.ok(html.includes(`src="${welcomeOpts.scriptUri}"`));
});
