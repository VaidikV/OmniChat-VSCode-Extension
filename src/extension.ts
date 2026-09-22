/**
 * OmniChat extension entry point (EE-3).
 *
 * Thin by design: command registration, surface wiring, config-change
 * fan-out, last-active-editor tracking (FR-17 build note), and the
 * one-time legacy migration (called last).
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { invalidateProviderCache } from './providers/factory.js';
import { runMigration } from './state/migration.js';
import { ChatOrchestrator } from './ui/chatPanel.js';
import type { ExtensionDeps } from './ui/deps.js';
import { openModelPicker } from './ui/modelPicker.js';
import { runSetupWizard } from './ui/setupWizard.js';
import { createStatusBar } from './ui/statusBar.js';
import { refreshWelcomeView, registerWelcomeView } from './ui/welcomeView.js';
import { info, initLog } from './util/log.js';

/**
 * Last active text editor. window.activeTextEditor is undefined while the
 * chat WebviewPanel has focus, so the host tracks the last non-undefined
 * editor and falls back to it (FR-17 build note).
 */
let lastActiveEditor: vscode.TextEditor | undefined;

function resolveTargetEditor(): vscode.TextEditor | undefined {
  const active = vscode.window.activeTextEditor;
  if (active) {
    return active;
  }
  if (lastActiveEditor && !lastActiveEditor.document.isClosed) {
    return lastActiveEditor;
  }
  return undefined;
}

let orchestrator: ChatOrchestrator | undefined;

/** Maximum selection characters inserted into the chat draft (AC-16d). */
const MAX_SELECTION_CHARS = 8000;

/**
 * FR-16: send the primary editor selection to the chat panel as a quoted
 * context block, appended after any existing draft.
 */
async function askAboutSelection(deps: ExtensionDeps): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const selection = editor?.selection;
  if (!editor || !selection || selection.isEmpty) {
    await vscode.window.showInformationMessage(
      'Select some code first, then run "OmniChat: Ask about selection" to ask about it.',
    );
    return;
  }
  const raw = editor.document.getText(selection); // primary selection only
  const truncated = raw.length > MAX_SELECTION_CHARS;
  const code = truncated ? raw.slice(0, MAX_SELECTION_CHARS) : raw;
  const fileName = path.basename(editor.document.fileName);
  const lines = [
    ...(truncated
      ? ['Note: this selection was longer than 8,000 characters and has been truncated.']
      : []),
    `Code from ${fileName}`,
    `\`\`\`${editor.document.languageId}`,
    code,
    '```',
  ];
  deps.appendChatContext(lines.join('\n'));
  info(`askAboutSelection: ${fileName} (${code.length} chars${truncated ? ', truncated' : ''})`);
}

export function activate(context: vscode.ExtensionContext): void {
  initLog(context);
  info('OmniChat activating');

  let orchestratorRef: ChatOrchestrator | undefined;

  const deps: ExtensionDeps = {
    ctx: context,
    runSetupWizard: (opts) => runSetupWizard(deps, opts),
    openModelPicker: (opts) => openModelPicker(deps, opts),
    revealChat: () => orchestratorRef?.reveal(),
    insertPromptToChat: (text) => orchestratorRef?.insertPrompt(text),
    appendChatContext: (text) => orchestratorRef?.appendContext(text),
    refreshSurfaces: () => {
      void statusBar.refresh();
      refreshWelcomeView(deps);
      // Config-change fan-out posts the switch note exactly once: the
      // tuple comparison dedupes against the onDidChangeConfiguration path.
      void orchestratorRef?.onConfigChanged();
    },
    resolveTargetEditor: () => resolveTargetEditor(),
  };

  orchestratorRef = new ChatOrchestrator(deps);
  orchestrator = orchestratorRef;

  const statusBar = createStatusBar(deps);
  const welcomeView = registerWelcomeView(deps);
  context.subscriptions.push(statusBar, welcomeView);

  context.subscriptions.push(
    vscode.commands.registerCommand('omnichat.start', () => {
      orchestratorRef?.reveal();
    }),
    vscode.commands.registerCommand('omnichat.switchModel', () => {
      void deps.openModelPicker();
    }),
    vscode.commands.registerCommand('omnichat.setup', () => {
      void deps.runSetupWizard();
    }),
    vscode.commands.registerCommand('omnichat.askAboutSelection', () => {
      void askAboutSelection(deps);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('omnichat')) {
        invalidateProviderCache();
        void orchestratorRef?.onConfigChanged();
        void statusBar.refresh();
        refreshWelcomeView(deps);
      }
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((e) => {
      // Update only on non-undefined events (FR-17 build note).
      if (e) {
        lastActiveEditor = e;
      }
      void orchestratorRef?.refreshInsertState();
    }),
  );

  // One-time legacy migration: runs last.
  void runMigration(context);
}

export function deactivate(): void {
  orchestrator?.dispose();
  orchestrator = undefined;
}
