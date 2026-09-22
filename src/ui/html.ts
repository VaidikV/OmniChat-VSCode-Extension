/**
 * Webview HTML builder. Pure module: MUST NOT import 'vscode'.
 *
 * Emits the exact strict CSP from technical-design.md section 4.2:
 *   default-src 'none';
 *   script-src 'nonce-{N}';
 *   style-src 'nonce-{N}';
 *   img-src {cspSource} data:;
 *   font-src {cspSource};
 *   connect-src 'none'
 *
 * Zero inline <script> or <style> blocks: scripts and styles reference the
 * esbuild bundle URIs with the nonce attribute. EE-3 supplies
 * webview.cspSource and webview.asWebviewUri(...) values for the options.
 */

export interface WebviewHtmlOptions {
  /** Per-load nonce; also embedded in the CSP script-src/style-src. */
  nonce: string;
  /** webview.cspSource, supplied by the extension host. */
  cspSource: string;
  /** asWebviewUri(...) of media/webview/bundle.js (chat) or welcome.js. */
  scriptUri: string;
  /** asWebviewUri(...) of media/webview/bundle.css. */
  styleUri: string;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cspMetaTag(nonce: string, cspSource: string): string {
  const n = escapeAttr(nonce);
  const s = escapeAttr(cspSource);
  return (
    `<meta http-equiv="Content-Security-Policy" content="` +
    `default-src 'none'; ` +
    `script-src 'nonce-${n}'; ` +
    `style-src 'nonce-${n}'; ` +
    `img-src ${s} data:; ` +
    `font-src ${s}; ` +
    `connect-src 'none'` +
    `">`
  );
}

function head(nonce: string, o: WebviewHtmlOptions, title: string): string {
  return (
    `<meta charset="UTF-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1.0">\n` +
    `${cspMetaTag(nonce, o.cspSource)}\n` +
    `<link rel="stylesheet" nonce="${nonce}" href="${escapeAttr(o.styleUri)}">\n` +
    `<title>${escapeAttr(title)}</title>`
  );
}

function scriptTag(nonce: string, scriptUri: string): string {
  return `<script nonce="${nonce}" src="${escapeAttr(scriptUri)}"></script>`;
}

/** Full HTML for the chat panel. */
export function buildChatHtml(o: WebviewHtmlOptions): string {
  const nonce = escapeAttr(o.nonce);
  return `<!DOCTYPE html>
<html lang="en">
<head>
${head(nonce, o, 'OmniChat')}
</head>
<body>
  <div class="chat-container">
    <div class="chat-header">
      <div class="chat-title">
        <div class="chat-icon" aria-hidden="true">&#129504;</div>
        <h1>OmniChat</h1>
      </div>
      <div class="chat-controls">
        <div class="model-info">Model: <span id="currentModel">Loading...</span></div>
      </div>
    </div>
    <div id="privacyLine" class="privacy-line"></div>
    <div id="setupCta" class="setup-cta" hidden>OmniChat isn't set up yet. Open the OmniChat view in the Activity Bar to run the two-minute setup.</div>
    <div class="chat-messages" id="chatMessages"></div>
    <div class="chat-input-container">
      <textarea id="prompt" placeholder="Ask me anything... (Enter to send, Shift+Enter for new line)"></textarea>
      <button id="askBtn" type="button">Ask</button>
      <button id="stopBtn" type="button" hidden>Stop</button>
    </div>
  </div>
  ${scriptTag(nonce, o.scriptUri)}
</body>
</html>`;
}

/** Full HTML for the welcome WebviewView. */
export function buildWelcomeHtml(o: WebviewHtmlOptions): string {
  const nonce = escapeAttr(o.nonce);
  return `<!DOCTYPE html>
<html lang="en">
<head>
${head(nonce, o, 'OmniChat')}
</head>
<body>
  <div id="welcomeRoot" class="welcome-view"></div>
  ${scriptTag(nonce, o.scriptUri)}
</body>
</html>`;
}
