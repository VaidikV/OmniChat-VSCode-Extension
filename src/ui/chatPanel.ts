/**
 * Chat panel orchestrator (EE-3, build groups 6-9).
 *
 * Owns the WebviewPanel lifecycle, message routing, and generation:
 *  - One AbortController per generation. Stop ({command:'cancel'}) or panel
 *    dispose aborts it; the AbortError is swallowed via isAbortError(), the
 *    partial response stays visible, and no truncated assistant message is
 *    appended to history.
 *  - The input stays disabled while generating ({command:'setGenerating'}).
 *  - Fenced code blocks are parsed from the latest completed assistant
 *    response; {command:'insertAtCursor'} inserts one at the target editor
 *    cursor as a single undoable edit (FR-17).
 *  - insertState is pushed on every completed response and whenever the
 *    target editor changes.
 *  - Provider/model switches preserve the transcript and post a visible
 *    note with the privacy disclosure (decision #25, AC-10d).
 *  - On panel open the configured model is validated against listModels();
 *    a missing model raises MODEL_REMOVED (E8). Setup-incomplete renders
 *    the setup CTA.
 *  - The conversation array lives host-side and is sent with every request.
 */

import * as vscode from 'vscode';
import {
  OmniChatError,
  type ErrorCode,
} from '../providers/errors.js';
import { createProvider } from '../providers/factory.js';
import { isAbortError } from '../providers/stream.js';
import type { ChatMessage, ProviderId } from '../providers/types.js';
import { readSettings } from '../state/settings.js';
import { createNonce } from '../util/nonce.js';
import { debug, error as logError, info } from '../util/log.js';
import { buildChatHtml } from './html.js';
import { codeBlockLabel, parseCodeBlocks, type CodeBlock } from './codeBlocks.js';
import type { ExtensionDeps } from './deps.js';
import {
  chatErrorPayload,
  executeRecoveryAction,
  logErrorDetail,
  type RecoveryActionContext,
} from './errorPresenter.js';
import {
  activeModel,
  isSetupComplete,
  privacyLabelFor,
  providerDisplayName,
} from './settingsUtil.js';

interface InitState {
  providerId: ProviderId;
  providerDisplayName: string;
  modelId: string;
  privacyLabel: string;
  setupComplete: boolean;
}

export class ChatOrchestrator {
  private panel: vscode.WebviewPanel | undefined;
  private webviewReady = false;
  private pending: unknown[] = [];
  private conversation: ChatMessage[] = [];
  private generating = false;
  private aborter: AbortController | undefined;
  private lastUserText = '';
  private codeBlocks: CodeBlock[] = [];
  private responseCompleted = false;
  private lastProvider: ProviderId | '' = '';
  private lastModel = '';
  private lastErrorCtx: RecoveryActionContext | undefined;
  private lastErrorCode: ErrorCode | undefined;

  constructor(private readonly deps: ExtensionDeps) {}

  // ------------------------------------------------------------------
  // Panel lifecycle
  // ------------------------------------------------------------------

  /** Reveal the chat panel, creating it on first use. */
  reveal(): void {
    this.ensurePanel();
    this.panel?.reveal(vscode.ViewColumn.One);
  }

  /** Reveal and set the composer text (welcome view "try it" prompts). */
  insertPrompt(text: string): void {
    this.reveal();
    this.post({ command: 'insertPrompt', text });
  }

  /** Reveal and append a context block after the existing draft (FR-16). */
  appendContext(text: string): void {
    this.reveal();
    this.post({ command: 'appendContext', text });
  }

  private ensurePanel(): void {
    if (this.panel) {
      return;
    }
    const { ctx } = this.deps;
    const panel = vscode.window.createWebviewPanel(
      'omniChat',
      'OmniChat',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media', 'webview')],
      },
    );
    this.panel = panel;
    this.webviewReady = false;
    this.pending = [];

    const nonce = createNonce();
    panel.webview.html = buildChatHtml({
      nonce,
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview
        .asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', 'webview', 'bundle.js'))
        .toString(),
      styleUri: panel.webview
        .asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', 'webview', 'bundle.css'))
        .toString(),
    });

    panel.onDidDispose(
      () => {
        this.aborter?.abort();
        this.panel = undefined;
        this.webviewReady = false;
        debug('chat panel disposed');
      },
      undefined,
      ctx.subscriptions,
    );

    panel.webview.onDidReceiveMessage(
      (msg) => {
        void this.onWebviewMessage(msg);
      },
      undefined,
      ctx.subscriptions,
    );

    const settings = readSettings();
    this.lastProvider = settings.provider;
    this.lastModel = activeModel(settings);
  }

  private post(message: unknown): void {
    if (this.webviewReady && this.panel) {
      void this.panel.webview.postMessage(message);
    } else {
      this.pending.push(message);
    }
  }

  private flushPending(): void {
    const queued = this.pending;
    this.pending = [];
    for (const message of queued) {
      void this.panel?.webview.postMessage(message);
    }
  }

  // ------------------------------------------------------------------
  // Init state
  // ------------------------------------------------------------------

  private async buildInitState(): Promise<InitState> {
    const settings = readSettings();
    return {
      providerId: settings.provider,
      providerDisplayName: providerDisplayName(settings.provider),
      modelId: activeModel(settings),
      privacyLabel: privacyLabelFor(settings),
      setupComplete: await isSetupComplete(this.deps.ctx),
    };
  }

  private async postInit(): Promise<void> {
    this.post({ command: 'init', state: await this.buildInitState() });
  }

  // ------------------------------------------------------------------
  // Message routing
  // ------------------------------------------------------------------

  private async onWebviewMessage(msg: { command?: string; [key: string]: unknown }): Promise<void> {
    switch (msg.command) {
      case 'ready': {
        this.webviewReady = true;
        this.flushPending();
        await this.postInit();
        await this.refreshInsertState();
        await this.validateModelOnOpen();
        return;
      }
      case 'send': {
        const text = typeof msg.text === 'string' ? msg.text : '';
        if (text.trim()) {
          await this.runGeneration(text);
        }
        return;
      }
      case 'cancel': {
        this.aborter?.abort();
        return;
      }
      case 'errorAction': {
        const id = typeof msg.id === 'string' ? msg.id : '';
        if (id && this.lastErrorCode) {
          await executeRecoveryAction(
            id as Parameters<typeof executeRecoveryAction>[0],
            this.deps,
            {
              ...(this.lastErrorCtx ?? {}),
              retry: () => this.retryLast(),
            },
          );
        }
        return;
      }
      case 'insertAtCursor': {
        const blockIndex = typeof msg.blockIndex === 'number' ? msg.blockIndex : undefined;
        await this.handleInsertAtCursor(blockIndex);
        return;
      }
      case 'openSetup': {
        await this.deps.runSetupWizard();
        return;
      }
      case 'switchModel': {
        await this.deps.openModelPicker();
        return;
      }
      case 'openChat': {
        this.reveal();
        return;
      }
      case 'usePrompt': {
        const text = typeof msg.text === 'string' ? msg.text : '';
        if (text) {
          this.insertPrompt(text);
        }
        return;
      }
      default:
        debug(`chatPanel: ignored unknown command ${String(msg.command)}`);
    }
  }

  // ------------------------------------------------------------------
  // Generation
  // ------------------------------------------------------------------

  private async runGeneration(userText: string): Promise<void> {
    if (this.generating) {
      return;
    }
    this.generating = true;
    this.lastUserText = userText;
    this.post({ command: 'setGenerating', generating: true });
    this.conversation.push({ role: 'user', content: userText });

    const settings = readSettings();
    const model = activeModel(settings);
    const providerName = providerDisplayName(settings.provider);
    this.aborter = new AbortController();
    info(`chat: ${settings.provider} ${model} (${this.conversation.length} messages)`);

    try {
      const provider = await createProvider(this.deps.ctx);
      const stream = provider.chatStream({
        model,
        messages: [...this.conversation],
        signal: this.aborter.signal,
        stallTimeoutMs: settings.requestTimeout * 1000,
      });
      let text = '';
      for await (const ev of stream) {
        if (ev.type === 'token') {
          text += ev.text;
          this.post({ command: 'token', text: ev.text });
        } else if (ev.type === 'reasoning') {
          this.post({ command: 'reasoning', text: ev.text });
        } else if (ev.type === 'done') {
          this.post({
            command: 'done',
            promptTokens: ev.promptTokens,
            completionTokens: ev.completionTokens,
          });
        }
      }
      this.conversation.push({ role: 'assistant', content: text });
      this.codeBlocks = parseCodeBlocks(text);
      this.responseCompleted = true;
      await this.refreshInsertState();
    } catch (err) {
      if (isAbortError(err)) {
        // Stop pressed or panel disposed: keep the partial response visible,
        // do not append a truncated assistant message to history.
        this.post({ command: 'generationStopped' });
        info('chat: generation stopped by user');
      } else {
        await this.handleChatError(err, {
          model,
          baseUrl: settings.provider === 'ollama' ? settings.ollama.baseUrl : undefined,
          providerId: settings.provider,
          providerDisplayName: providerName,
        });
      }
    } finally {
      this.generating = false;
      this.aborter = undefined;
      this.post({ command: 'setGenerating', generating: false });
    }
  }

  private async retryLast(): Promise<void> {
    if (this.lastUserText && !this.generating) {
      // Drop the failed user turn's echo? No: runGeneration re-pushes it,
      // so remove the previous push to avoid duplication.
      const last = this.conversation[this.conversation.length - 1];
      if (last && last.role === 'user' && last.content === this.lastUserText) {
        this.conversation.pop();
      }
      await this.runGeneration(this.lastUserText);
    }
  }

  private async handleChatError(err: unknown, actx: RecoveryActionContext): Promise<void> {
    const code: ErrorCode = err instanceof OmniChatError ? err.code : 'UNKNOWN';
    if (code === 'CANCELLED') {
      return; // silent by convention
    }
    logErrorDetail(code, err);
    this.lastErrorCode = code;
    this.lastErrorCtx = {
      ...actx,
      details: err instanceof Error ? `${code}: ${err.message}` : `${code}: ${String(err)}`,
    };
    const payload = chatErrorPayload(code, actx);
    this.post({ command: 'error', code, message: payload.message, actions: payload.actions });
  }

  // ------------------------------------------------------------------
  // Model validation on open (E8)
  // ------------------------------------------------------------------

  private async validateModelOnOpen(): Promise<void> {
    const settings = readSettings();
    const model = activeModel(settings);
    if (!model) {
      return;
    }
    if (!(await isSetupComplete(this.deps.ctx))) {
      return; // setup CTA is showing; validation happens after setup
    }
    let models: Array<{ id: string }>;
    try {
      const provider = await createProvider(this.deps.ctx);
      models = await provider.listModels();
    } catch (err) {
      // Detection failure here is not fatal: the first send surfaces it
      // with recovery actions.
      logErrorDetail('UNKNOWN', err);
      return;
    }
    if (!models.some((m) => m.id === model)) {
      const actx: RecoveryActionContext = {
        model,
        providerId: settings.provider,
        providerDisplayName: providerDisplayName(settings.provider),
      };
      logError(`MODEL_REMOVED: ${model}`);
      this.lastErrorCode = 'MODEL_REMOVED';
      this.lastErrorCtx = actx;
      const payload = chatErrorPayload('MODEL_REMOVED', actx);
      this.post({
        command: 'error',
        code: 'MODEL_REMOVED',
        message: payload.message,
        actions: payload.actions,
      });
    }
  }

  // ------------------------------------------------------------------
  // Config changes: preserve transcript, post the switch note (AC-10d)
  // ---------------------------------------------------------------------------

  /** Called from onDidChangeConfiguration for omnichat.* (cache is invalidated there). */
  async onConfigChanged(): Promise<void> {
    if (!this.panel) {
      return;
    }
    const settings = readSettings();
    const provider = settings.provider;
    const model = activeModel(settings);
    const changed = provider !== this.lastProvider || model !== this.lastModel;
    const hadPrior = this.lastProvider !== '';
    this.lastProvider = provider;
    this.lastModel = model;
    await this.postInit();
    await this.refreshInsertState();
    if (changed && hadPrior) {
      const display = providerDisplayName(provider);
      const target = model || display;
      // AC-10d: transcript is preserved (conversation is never cleared);
      // the note discloses that the next message sends the prior
      // conversation to the new provider (decision #25).
      this.post({
        command: 'notice',
        text: `Switched to ${target}. Earlier messages stay in this chat. Your next message will send this conversation to ${display}.`,
      });
      info(`chat: switched to ${provider} ${model}`);
    }
  }

  // ------------------------------------------------------------------
  // FR-17: insert at cursor
  // ------------------------------------------------------------------

  /** Push insertState; called after each completed response and whenever the target editor changes. */
  async refreshInsertState(): Promise<void> {
    const editor = this.deps.resolveTargetEditor();
    const hasBlocks = this.codeBlocks.length > 0;
    let tooltip: string;
    if (!editor) {
      tooltip = 'No file is open. Open a file and place your cursor where you want the code.';
    } else if (!hasBlocks) {
      tooltip = this.responseCompleted
        ? 'The latest response has no code block to insert.'
        : 'Insert code at cursor becomes available after the assistant responds.';
    } else {
      tooltip = 'Insert code at cursor';
    }
    this.post({
      command: 'insertState',
      enabled: hasBlocks && !!editor,
      blockCount: this.codeBlocks.length,
      tooltip,
    });
  }

  private async handleInsertAtCursor(blockIndex?: number): Promise<void> {
    const blocks = this.codeBlocks;
    let index = blockIndex;
    if (index === undefined) {
      if (blocks.length === 0) {
        return; // button is disabled in this state; guard anyway
      }
      if (blocks.length === 1) {
        index = 0;
      } else {
        const picked = await vscode.window.showQuickPick(
          blocks.map((b, i) => ({ label: codeBlockLabel(i, b), index: i })),
          { placeHolder: 'Choose a code block to insert at the cursor' },
        );
        if (!picked) {
          return;
        }
        index = picked.index;
      }
    }
    const block = blocks[index ?? -1];
    if (!block) {
      return;
    }
    const editor = this.deps.resolveTargetEditor();
    if (!editor) {
      await vscode.window.showInformationMessage(
        'No file is open. Open a file and place your cursor where you want the code.',
      );
      return;
    }
    // Exactly one edit() call: a single undo stop (FR-17 build note).
    await editor.edit((editBuilder) => {
      editBuilder.insert(editor.selection.active, block.code);
    });
    info(`chat: inserted code block at cursor (${block.code.length} chars)`);
  }

  dispose(): void {
    this.aborter?.abort();
    this.panel?.dispose();
  }
}
