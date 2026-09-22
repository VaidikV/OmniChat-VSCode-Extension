/**
 * Chat panel webview script.
 *
 * Message protocol (webview side; EE-3 implements the matching host side):
 *   Outgoing: {command:'ready'}, {command:'send', text},
 *             {command:'cancel'}, {command:'errorAction', id}
 *   Incoming: {command:'init', state}, {command:'token', text},
 *             {command:'reasoning', text}, {command:'done', ...},
 *             {command:'generationStopped'}, {command:'error', ...},
 *             {command:'notice', text}, {command:'insertPrompt', text},
 *             {command:'setGenerating', generating},
 *             {command:'insertState', enabled, blockCount, tooltip},
 *             {command:'appendContext', text}
 * Unrecognized incoming commands are ignored (forward-compat).
 * Zero network calls; zero console output.
 *
 * FR-17: the "Insert code at cursor" button is always rendered; the host
 * drives its disabled state and tooltip via insertState. Clicking posts
 * {command:'insertAtCursor'}. FR-16: appendContext appends a quoted code
 * block after the existing draft and focuses the composer.
 */
/// <reference path="./vscode-api.d.ts" />
import { renderMarkdown } from './render';

interface InitState {
  providerId: string;
  providerDisplayName: string;
  modelId: string;
  privacyLabel: string;
  setupComplete: boolean;
}

interface ErrorAction {
  id: string;
  label: string;
}

interface ChatViewState {
  chatHistory?: string;
}

const vscode = acquireVsCodeApi<ChatViewState>();

const chatMessages = document.getElementById('chatMessages') as HTMLElement;
const promptTextarea = document.getElementById('prompt') as HTMLTextAreaElement;
const askBtn = document.getElementById('askBtn') as HTMLButtonElement;
const stopBtn = document.getElementById('stopBtn') as HTMLButtonElement;
const currentModelEl = document.getElementById('currentModel') as HTMLElement;
const privacyLineEl = document.getElementById('privacyLine') as HTMLElement;
const setupCtaEl = document.getElementById('setupCta') as HTMLElement;

// FR-17: "Insert code at cursor" button. Always rendered (never hidden);
// the host drives disabled + tooltip via insertState so the tooltip stays
// reachable in every disabled state (AC-17g).
const insertBtn = document.createElement('button');
insertBtn.id = 'insertBtn';
insertBtn.type = 'button';
insertBtn.textContent = 'Insert code at cursor';
insertBtn.disabled = true;
insertBtn.title = 'Insert code at cursor becomes available after the assistant responds.';
document.querySelector('.chat-input-container')?.appendChild(insertBtn);

let isGenerating = false;
let userHasScrolled = false;
let assistantEl: HTMLElement | null = null;
let assistantText = '';
let reasoningText = '';

function scrollToBottom(): void {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function isUserAtBottom(): boolean {
  const tolerance = 50;
  return chatMessages.scrollHeight - chatMessages.clientHeight - chatMessages.scrollTop <= tolerance;
}

function saveState(): void {
  vscode.setState({ chatHistory: chatMessages.innerHTML });
}

/** Drives Stop-button visibility and the input disabled state. */
function setGeneratingUI(generating: boolean): void {
  isGenerating = generating;
  promptTextarea.disabled = generating;
  askBtn.disabled = generating;
  stopBtn.hidden = !generating;
  if (!generating) {
    promptTextarea.focus();
    userHasScrolled = false;
  }
}

function addUserMessage(text: string): void {
  const wrap = document.createElement('div');
  wrap.className = 'message-container user-message-container';
  const msg = document.createElement('div');
  msg.className = 'message user-message';
  const content = document.createElement('div');
  content.className = 'message-content';
  content.innerHTML = renderMarkdown(text);
  msg.appendChild(content);
  wrap.appendChild(msg);
  chatMessages.appendChild(wrap);
  scrollToBottom();
  userHasScrolled = false;
}

function ensureAssistantEl(): HTMLElement {
  if (!assistantEl) {
    const wrap = document.createElement('div');
    wrap.className = 'message-container bot-message-container';
    assistantEl = document.createElement('div');
    assistantEl.className = 'message bot-message';
    const content = document.createElement('div');
    content.className = 'message-content';
    content.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
    assistantEl.appendChild(content);
    wrap.appendChild(assistantEl);
    chatMessages.appendChild(wrap);
    scrollToBottom();
  }
  return assistantEl;
}

function renderAssistant(): void {
  const el = ensureAssistantEl();
  const content = el.querySelector('.message-content') as HTMLElement;
  const combined = (reasoningText ? '<think>' + reasoningText + '</think>\n\n' : '') + assistantText;
  content.innerHTML = combined.trim()
    ? renderMarkdown(combined)
    : '<div class="typing-indicator"><span></span><span></span><span></span></div>';
  if (!userHasScrolled) {
    scrollToBottom();
  }
}

/** Keep the partial response visible; drop the empty placeholder if any. */
function finalizeResponse(): void {
  if (assistantEl && !assistantText.trim() && !reasoningText.trim()) {
    const wrap = assistantEl.closest('.message-container');
    if (wrap) {
      wrap.remove();
    }
  } else if (assistantEl) {
    renderAssistant();
  }
  assistantEl = null;
  assistantText = '';
  reasoningText = '';
  saveState();
}

function showError(message: string, actions: ErrorAction[]): void {
  const banner = document.createElement('div');
  banner.className = 'error-banner';

  const msg = document.createElement('div');
  msg.className = 'error-message';
  msg.textContent = message;
  banner.appendChild(msg);

  const row = document.createElement('div');
  row.className = 'error-actions';
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'error-action-btn';
    btn.textContent = action.label;
    btn.dataset.actionId = action.id;
    row.appendChild(btn);
  }
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'error-dismiss';
  dismiss.textContent = 'Dismiss';
  dismiss.dataset.dismiss = '1';
  row.appendChild(dismiss);
  banner.appendChild(row);

  chatMessages.appendChild(banner);
  scrollToBottom();
  saveState();
}

function showNotice(text: string): void {
  const note = document.createElement('div');
  note.className = 'system-notice';
  note.textContent = text;
  chatMessages.appendChild(note);
  scrollToBottom();
  saveState();
}

function showWelcome(state?: InitState): void {
  const welcome = document.createElement('div');
  welcome.className = 'welcome-message';

  const heading = document.createElement('h2');
  heading.textContent = 'Welcome to OmniChat';
  welcome.appendChild(heading);

  const body = document.createElement('p');
  if (state && state.setupComplete && state.modelId) {
    body.textContent = `You're chatting with ${state.modelId} on ${state.providerDisplayName}.`;
  } else {
    body.textContent = 'Chat with AI without leaving VS Code. Run the two-minute setup to begin.';
  }
  welcome.appendChild(body);

  chatMessages.appendChild(welcome);
}

function handleInit(state: InitState): void {
  currentModelEl.textContent = state.modelId || 'No model selected';
  privacyLineEl.textContent = state.privacyLabel || '';
  setupCtaEl.hidden = state.setupComplete !== false;
  if (chatMessages.children.length === 0) {
    showWelcome(state);
  }
  saveState();
}

function handleError(msg: { message?: string; actions?: ErrorAction[] }): void {
  finalizeResponse();
  showError(msg.message || 'Something unexpected happened.', msg.actions || []);
}

function insertPrompt(text: string): void {
  promptTextarea.value = text;
  promptTextarea.focus();
  promptTextarea.setSelectionRange(text.length, text.length);
}

/** FR-16: append a context block after the existing draft, focus composer. */
function appendContext(text: string): void {
  const current = promptTextarea.value;
  promptTextarea.value = current ? current.replace(/\s+$/, '') + '\n' + text : text;
  promptTextarea.focus();
  promptTextarea.setSelectionRange(promptTextarea.value.length, promptTextarea.value.length);
}

/** FR-17: host-driven enabled state + tooltip for the insert button. */
function handleInsertState(msg: { enabled?: boolean; tooltip?: string }): void {
  insertBtn.disabled = msg.enabled !== true;
  insertBtn.title = msg.tooltip || 'Insert code at cursor';
}

function send(): void {
  if (isGenerating) {
    return;
  }
  const text = promptTextarea.value.trim();
  if (!text) {
    return;
  }
  addUserMessage(text);
  promptTextarea.value = '';
  ensureAssistantEl();
  vscode.postMessage({ command: 'send', text });
  saveState();
}

function restoreState(): void {
  const state = vscode.getState();
  if (state && state.chatHistory) {
    chatMessages.innerHTML = state.chatHistory;
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
  if (chatMessages.children.length === 0) {
    showWelcome();
  }
}

chatMessages.addEventListener('scroll', () => {
  if (isGenerating && !isUserAtBottom()) {
    userHasScrolled = true;
  }
});

// Delegated clicks keep working for buttons restored from saved state.
chatMessages.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const btn = target.closest('button');
  if (!btn) {
    return;
  }
  if (btn.dataset.dismiss) {
    const banner = btn.closest('.error-banner');
    if (banner) {
      banner.remove();
      saveState();
    }
    return;
  }
  if (btn.dataset.actionId) {
    vscode.postMessage({ command: 'errorAction', id: btn.dataset.actionId });
  }
});

askBtn.addEventListener('click', send);

stopBtn.addEventListener('click', () => {
  vscode.postMessage({ command: 'cancel' });
});

insertBtn.addEventListener('click', () => {
  if (insertBtn.disabled) {
    return;
  }
  vscode.postMessage({ command: 'insertAtCursor' });
});

promptTextarea.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !isGenerating) {
    event.preventDefault();
    send();
  }
});

window.addEventListener('message', (event) => {
  const msg = (event.data || {}) as { command?: string; [key: string]: unknown };

  switch (msg.command) {
    case 'init':
      handleInit(msg.state as InitState);
      break;
    case 'token':
      assistantText += (msg.text as string) ?? '';
      renderAssistant();
      break;
    case 'reasoning':
      reasoningText += (msg.text as string) ?? '';
      renderAssistant();
      break;
    case 'done':
      finalizeResponse();
      setGeneratingUI(false);
      break;
    case 'generationStopped':
      finalizeResponse();
      setGeneratingUI(false);
      break;
    case 'error':
      handleError(msg as { message?: string; actions?: ErrorAction[] });
      break;
    case 'notice':
      showNotice((msg.text as string) ?? '');
      break;
    case 'insertPrompt':
      insertPrompt((msg.text as string) ?? '');
      break;
    case 'setGenerating':
      setGeneratingUI(msg.generating === true);
      break;
    case 'insertState':
      handleInsertState(msg as { enabled?: boolean; tooltip?: string });
      break;
    case 'appendContext':
      appendContext((msg.text as string) ?? '');
      break;
    default:
      // Forward-compat: ignore unrecognized commands.
      break;
  }
});

restoreState();
vscode.postMessage({ command: 'ready' });
