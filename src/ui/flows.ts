/**
 * Shared host-side flows used by the wizard, the model picker, and the
 * error presenter (EE-3).
 *
 *  - detectOllama(): the four detection states (decision #18, technical
 *    design section 3).
 *  - startOllamaFlow(): explicit-click `ollama serve` spawn + poll with the
 *    terminal fallback (decision #27). Returns true on success; never
 *    presents the E2 error itself (callers own that via errorPresenter).
 *  - pullModelFlow(): host-owned ollama pull shared by the wizard, the
 *    model picker, and the pull-model recovery action. Progress renders in
 *    two places (decision #22): an inline callback for the wizard and a
 *    cancellable VS Code progress notification. Cancelling from either
 *    surface aborts the same operation. Completion announces
 *    "{model} is ready." with a [Start chatting] action.
 *  - enterApiKeyFlow(): password-style key entry with inline validation.
 *
 * This module never imports errorPresenter/modelPicker/setupWizard; the
 * module graph stays acyclic (see ui/deps.ts).
 */

import * as vscode from 'vscode';
import { OmniChatError } from '../providers/errors.js';
import { GenericOpenAICompatibleProvider } from '../providers/genericOpenAI.js';
import {
  checkOllamaStatus,
  formatBytes,
  getOllamaModels,
  isOllamaInstalled,
  OllamaProvider,
  startOllama,
} from '../providers/ollama.js';
import { OpenRouterProvider } from '../providers/openrouter.js';
import { isAbortError } from '../providers/stream.js';
import type { ModelInfo, ProviderId, PullProgress } from '../providers/types.js';
import { readSettings } from '../state/settings.js';
import { debug, error, info } from '../util/log.js';
import type { ExtensionDeps } from './deps.js';

// ---------------------------------------------------------------------------
// Ollama detection
// ---------------------------------------------------------------------------

export interface OllamaDetection {
  installed: boolean;
  running: boolean;
  models: ModelInfo[];
  baseUrl: string;
}

/** The four detection states; never throws. */
export async function detectOllama(baseUrl?: string): Promise<OllamaDetection> {
  const url = baseUrl ?? readSettings().ollama.baseUrl;
  const installed = await isOllamaInstalled();
  const status = await checkOllamaStatus(url);
  const models = status.running ? await getOllamaModels(url) : [];
  debug(`detectOllama: installed=${installed} running=${status.running} models=${models.length}`);
  return { installed, running: status.running, models, baseUrl: url };
}

// ---------------------------------------------------------------------------
// Start Ollama (explicit click only)
// ---------------------------------------------------------------------------

/**
 * Spawn `ollama serve` detached and poll /api/version (decision #27). On
 * spawn failure the fallback opens a VS Code terminal running `ollama serve`
 * so the user sees what happened. Returns true when Ollama is up.
 */
export async function startOllamaFlow(deps: ExtensionDeps, baseUrl?: string): Promise<boolean> {
  const url = baseUrl ?? readSettings().ollama.baseUrl;
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Starting Ollama...',
        cancellable: false,
      },
      () => startOllama(url),
    );
  } catch (err) {
    error(`startOllama failed: ${err instanceof Error ? err.message : String(err)}`);
    openOllamaTerminalFallback();
    return false;
  }
  info('Ollama started via spawn');
  await vscode.window.showInformationMessage('Ollama is running.');
  return true;
}

/** Terminal fallback when spawning `ollama serve` fails (decision #27). */
function openOllamaTerminalFallback(): void {
  try {
    const terminal = vscode.window.createTerminal('OmniChat: Ollama');
    terminal.sendText('ollama serve');
    terminal.show();
  } catch (err) {
    error(`terminal fallback failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Copyable manual start command (E2 "Show me how to start it"). */
export async function showStartGuide(): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    'To start Ollama yourself, run this command: ollama serve',
    'Copy command',
  );
  if (choice === 'Copy command') {
    await vscode.env.clipboard.writeText('ollama serve');
  }
}

// ---------------------------------------------------------------------------
// Model pull (host-owned, survives wizard close)
// ---------------------------------------------------------------------------

interface PullOperation {
  model: string;
  controller: AbortController;
  done: Promise<void>;
}

const pullRegistry = new Map<string, PullOperation>();

/** The in-flight pull for a model, if any. */
export function getPullOperation(model: string): PullOperation | undefined {
  return pullRegistry.get(model);
}

export interface PullFlowOptions {
  /** Inline progress for the wizard screen (decision #22, first surface). */
  onProgress?: (p: PullProgress) => void;
}

/**
 * Pull an Ollama model with progress in two places: the caller's inline
 * onProgress and a cancellable VS Code progress notification. Cancelling
 * from either surface aborts the same operation. On success a notification
 * announces "{model} is ready." with [Start chatting] (decision #22).
 * Throws on failure (PULL_FAILED) or abort (AbortError); callers present.
 */
export function pullModelFlow(
  deps: ExtensionDeps,
  model: string,
  baseUrl?: string,
  opts: PullFlowOptions = {},
): Promise<void> {
  const existing = pullRegistry.get(model);
  if (existing) {
    return existing.done;
  }
  const url = baseUrl ?? readSettings().ollama.baseUrl;
  const controller = new AbortController();
  let resolveDone!: () => void;
  let rejectDone!: (err: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  pullRegistry.set(model, { model, controller, done });
  info(`pull started: ${model}`);

  const provider = new OllamaProvider(url);
  const task = vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Downloading ${model}`,
      cancellable: true,
    },
    async (progress, token) => {
      token.onCancellationRequested(() => controller.abort());
      await provider.pullModel(
        model,
        (p) => {
          const message =
            p.total > 0
              ? `${formatBytes(p.completed)} of ${formatBytes(p.total)}`
              : p.status || 'Downloading...';
          progress.report({ message });
          opts.onProgress?.(p);
        },
        controller.signal,
      );
    },
  );

  task.then(
    () => {
      pullRegistry.delete(model);
      info(`pull complete: ${model}`);
      vscode.window
        .showInformationMessage(`${model} is ready.`, 'Start chatting')
        .then((choice) => {
          if (choice === 'Start chatting') {
            deps.revealChat();
          }
        });
      resolveDone();
    },
    (err: unknown) => {
      pullRegistry.delete(model);
      if (isAbortError(err)) {
        info(`pull cancelled: ${model}`);
        void vscode.window.showInformationMessage(`${model} download cancelled.`);
      } else {
        error(`pull failed: ${model}: ${err instanceof Error ? err.message : String(err)}`);
      }
      rejectDone(err);
    },
  );
  return done;
}

// ---------------------------------------------------------------------------
// API key entry (password InputBox, inline validation)
// ---------------------------------------------------------------------------

export type KeyProviderId = Extract<ProviderId, 'openrouter' | 'custom'>;

export interface KeyEntryOptions {
  title?: string;
  /**
   * Custom validation (runs the provider's checkConnection). Defaults to a
   * key check against the provider's configured endpoint.
   */
  validate?: (key: string) => Promise<void>;
}

/**
 * Password-style key entry. Validates inline with checkConnection: a 401
 * keeps the box open with "That key didn't work. Check it and try again."
 * (E5). Returns the key, or undefined when the user goes back / cancels.
 * The key is NOT stored here; callers store via storeSecret on commit.
 */
export async function enterApiKeyFlow(
  providerId: KeyProviderId,
  opts: KeyEntryOptions = {},
): Promise<{ key: string } | { back: true } | undefined> {
  const isOpenRouter = providerId === 'openrouter';
  const input = vscode.window.createInputBox();
  input.title = opts.title ?? (isOpenRouter ? 'Connect OpenRouter' : 'Service API key');
  input.prompt = isOpenRouter
    ? 'Paste your OpenRouter API key. It is stored securely in VS Code and never leaves your machine except to talk to OpenRouter.'
    : 'Enter the API key for your service, if it needs one.';
  input.password = true;
  input.placeholder = 'Paste your key here';
  input.ignoreFocusOut = true;
  const buttons: vscode.QuickInputButton[] = [vscode.QuickInputButtons.Back];
  if (isOpenRouter) {
    buttons.push({
      iconPath: new vscode.ThemeIcon('link-external'),
      tooltip: 'Get a free key',
    });
  }
  input.buttons = buttons;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { key: string } | { back: true } | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      input.dispose();
      resolve(value);
    };
    input.onDidTriggerButton(async (button) => {
      if (button === vscode.QuickInputButtons.Back) {
        finish({ back: true });
        return;
      }
      await vscode.env.openExternal(
        vscode.Uri.parse('https://openrouter.ai/keys'),
      );
    });
    input.onDidAccept(async () => {
      const value = input.value.trim();
      if (!value) {
        input.validationMessage = 'Paste your API key to continue.';
        return;
      }
      input.busy = true;
      input.validationMessage = undefined;
      try {
        if (opts.validate) {
          await opts.validate(value);
        } else {
          await checkKey(value, providerId);
        }
      } catch (err) {
        input.busy = false;
        if (err instanceof OmniChatError && err.code === 'UNAUTHORIZED') {
          input.validationMessage = "That key didn't work. Check it and try again.";
        } else {
          input.validationMessage = 'Could not reach the provider. Check your connection and try again.';
        }
        input.show();
        return;
      }
      input.busy = false;
      finish({ key: value });
    });
    input.onDidHide(() => finish(undefined));
    input.show();
  });
}

/** Validate a candidate key without storing it. */
async function checkKey(key: string, providerId: KeyProviderId): Promise<void> {
  if (providerId === 'openrouter') {
    await new OpenRouterProvider(key).checkConnection();
    return;
  }
  const baseUrl = readSettings().custom.baseUrl;
  await new GenericOpenAICompatibleProvider(baseUrl, key).checkConnection();
}
