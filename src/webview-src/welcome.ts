/**
 * Welcome view webview script (WebviewView).
 *
 * Incoming: {command:'init', state:{setupComplete, providerDisplayName?,
 *            modelId?, privacyLabel?}}
 * Outgoing: {command:'ready'}, {command:'openSetup'}, {command:'switchModel'},
 *           {command:'openChat'}, {command:'usePrompt', text}
 * Unrecognized incoming commands are ignored (forward-compat).
 * Zero network calls; zero console output. Copy matches
 * phase-0/ux-wizard-flow.md (welcome view section) verbatim.
 */
/// <reference path="./vscode-api.d.ts" />

interface WelcomeState {
  setupComplete: boolean;
  providerDisplayName?: string;
  modelId?: string;
  privacyLabel?: string;
}

const vscode = acquireVsCodeApi();
const root = document.getElementById('welcomeRoot') as HTMLElement;

const TRY_IT_PROMPTS = [
  'Explain this error message.',
  'Write a test for the function I just wrote.',
  'Summarize what this file does.',
];

function makeButton(label: string, command: string, promptText?: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.dataset.command = command;
  if (promptText !== undefined) {
    btn.dataset.prompt = promptText;
  }
  return btn;
}

function renderEmpty(): void {
  root.innerHTML = '';

  const heading = document.createElement('h1');
  heading.textContent = 'Welcome to OmniChat';
  root.appendChild(heading);

  const sub = document.createElement('p');
  sub.className = 'welcome-sub';
  sub.textContent = 'Chat with AI without leaving VS Code.';
  root.appendChild(sub);

  const steps = document.createElement('ol');
  steps.className = 'welcome-steps';

  const step1 = document.createElement('li');
  const step1Text = document.createElement('span');
  step1Text.textContent = 'Run the two-minute setup. ';
  step1.appendChild(step1Text);
  step1.appendChild(makeButton('Set up OmniChat', 'openSetup'));
  steps.appendChild(step1);

  const step2 = document.createElement('li');
  step2.textContent = 'Pick a model from the list.';
  steps.appendChild(step2);

  const step3 = document.createElement('li');
  step3.textContent = 'Ask anything.';
  steps.appendChild(step3);

  root.appendChild(steps);
}

function renderReady(state: WelcomeState): void {
  root.innerHTML = '';

  const status = document.createElement('p');
  status.className = 'welcome-status';
  const model = state.modelId || 'no model';
  const provider = state.providerDisplayName || 'your provider';
  status.textContent = `You're chatting with ${model} on ${provider}.`;
  root.appendChild(status);

  const actions = document.createElement('div');
  actions.className = 'welcome-actions';
  actions.appendChild(makeButton('Change', 'switchModel'));
  actions.appendChild(makeButton('New chat', 'openChat'));
  root.appendChild(actions);

  const tryLabel = document.createElement('p');
  tryLabel.className = 'welcome-try-label';
  tryLabel.textContent = 'Three things to try:';
  root.appendChild(tryLabel);

  const list = document.createElement('ul');
  list.className = 'welcome-prompts';
  for (const promptText of TRY_IT_PROMPTS) {
    const item = document.createElement('li');
    item.appendChild(makeButton(promptText, 'usePrompt', promptText));
    list.appendChild(item);
  }
  root.appendChild(list);

  if (state.privacyLabel) {
    const privacy = document.createElement('p');
    privacy.className = 'privacy-line';
    privacy.textContent = state.privacyLabel;
    root.appendChild(privacy);
  }
}

root.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const btn = target.closest('button');
  if (!btn || !btn.dataset.command) {
    return;
  }
  const command = btn.dataset.command;
  if (command === 'usePrompt') {
    vscode.postMessage({ command: 'usePrompt', text: btn.dataset.prompt ?? '' });
  } else {
    vscode.postMessage({ command });
  }
});

window.addEventListener('message', (event) => {
  const msg = (event.data || {}) as { command?: string; state?: WelcomeState };
  if (msg.command !== 'init') {
    return;
  }
  const state = msg.state || { setupComplete: false };
  if (state.setupComplete) {
    renderReady(state);
  } else {
    renderEmpty();
  }
});

// Empty state until the host tells us otherwise.
renderEmpty();
vscode.postMessage({ command: 'ready' });
