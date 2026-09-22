/**
 * First-run setup wizard (FR-09, decisions #20, #22, #23, #24, #27, #30).
 *
 * Four steps (plus a welcome screen), all QuickPick-based per the
 * zero-typing law:
 *   0. Welcome ("Meet OmniChat") with "I'll do this later"
 *   1. Choose how to run AI (Ollama / OpenRouter / another service)
 *   2. Provider path:
 *      - Ollama: install / start / pick-or-pull-a-model variants from
 *        detection, with "Check again"
 *      - OpenRouter: password key entry (inline 401) then the grouped
 *        model picker (decision #21)
 *      - Custom: presets + custom URL, optional key, connection test,
 *        model list
 *   3. Test: auto-sends "Say hello in one short sentence." as the live test
 *   4. Done: "Everything works." completion screen states the provider, the
 *      model, and the per-provider privacy label, then commits configuration
 *      and toasts "OmniChat is ready. Ask anything."
 *
 * Resume semantics (decision #30): never-started begins at step 1,
 * interrupted resumes at the furthest completed step, cancelling leaves
 * prior configuration untouched (choices are buffered and only written at
 * Done). The wizard never auto-opens (decision #20); entry points are the
 * welcome view, the status bar "OmniChat: set up" item, and omnichat.setup.
 */

import * as vscode from 'vscode';
import { OmniChatError } from '../providers/errors.js';
import { invalidateProviderCache } from '../providers/factory.js';
import { GenericOpenAICompatibleProvider, normalizeBaseUrl } from '../providers/genericOpenAI.js';
import { formatBytes } from '../providers/ollama.js';
import { OllamaProvider } from '../providers/ollama.js';
import { OpenRouterProvider } from '../providers/openrouter.js';
import { isAbortError } from '../providers/stream.js';
import type { LLMProvider, ProviderId } from '../providers/types.js';
import { CUSTOM_API_KEY, OPENROUTER_API_KEY, storeSecret } from '../state/secrets.js';
import { applyDefaults, readSettings, type OmniChatSettings } from '../state/settings.js';
import { markWizardStep, readWizardState, resolveInitialStep, writeWizardState } from '../state/wizardState.js';
import { info } from '../util/log.js';
import type { ExtensionDeps, WizardOptions } from './deps.js';
import { logErrorDetail, presentError } from './errorPresenter.js';
import {
  detectOllama,
  enterApiKeyFlow,
  getPullOperation,
  pullModelFlow,
  startOllamaFlow,
  type OllamaDetection,
} from './flows.js';
import { pickOpenRouterModel, STARTER_MODELS, starterPullList } from './modelPicker.js';
import { privacyLabelFor, privacyTag, providerDisplayName, updateSetting } from './settingsUtil.js';

// ---------------------------------------------------------------------------
// Buffered wizard choices (committed at Done; cancel leaves config untouched)
// ---------------------------------------------------------------------------

interface WizardBuffer {
  provider: ProviderId;
  ollamaModel?: string;
  openrouterKey?: string;
  openrouterModel?: string;
  customBaseUrl?: string;
  customKey?: string;
  customModel?: string;
}

// ---------------------------------------------------------------------------
// QuickPick helpers
// ---------------------------------------------------------------------------

type StepOutcome<T> = { picked: T } | { back: true } | undefined;

function showPick<T extends vscode.QuickPickItem>(
  qp: vscode.QuickPick<T>,
  opts: { back?: boolean } = {},
): Promise<StepOutcome<T>> {
  if (opts.back) {
    qp.buttons = [vscode.QuickInputButtons.Back];
  }
  return new Promise((resolve) => {
    const disposables: vscode.Disposable[] = [];
    let settled = false;
    const done = (value: StepOutcome<T>) => {
      if (settled) {
        return;
      }
      settled = true;
      disposables.forEach((d) => d.dispose());
      qp.dispose();
      resolve(value);
    };
    if (opts.back) {
      disposables.push(
        qp.onDidTriggerButton((b) => {
          if (b === vscode.QuickInputButtons.Back) {
            done({ back: true });
          }
        }),
      );
    }
    disposables.push(
      qp.onDidAccept(() => {
        const item = qp.selectedItems[0];
        if (!item || (item as vscode.QuickPickItem).kind === vscode.QuickPickItemKind.Separator) {
          return;
        }
        done({ picked: item });
      }),
    );
    disposables.push(qp.onDidHide(() => done(undefined)));
    qp.show();
  });
}

function makePick<T extends vscode.QuickPickItem>(
  title: string,
  placeholder: string,
  items: T[],
): vscode.QuickPick<T> {
  const qp = vscode.window.createQuickPick<T>();
  qp.title = title;
  qp.placeholder = placeholder;
  qp.items = items;
  qp.canSelectMany = false;
  qp.ignoreFocusOut = true;
  return qp;
}

function separator(label: string): vscode.QuickPickItem {
  return { label, kind: vscode.QuickPickItemKind.Separator };
}

// ---------------------------------------------------------------------------
// Screen 0: Welcome
// ---------------------------------------------------------------------------

async function screenWelcome(): Promise<'next' | undefined> {
  const qp = makePick(
    'Meet OmniChat',
    'Chat with AI right inside VS Code. This quick setup takes about two minutes, and you only do it once.',
    [
      { label: 'Set up OmniChat', detail: 'Pick a provider and a model, then test it.' },
      { label: "I'll do this later", detail: 'You can run setup anytime from the status bar.' },
    ],
  );
  const r = await showPick(qp);
  if (!r || 'back' in r) {
    return undefined;
  }
  return r.picked.label === 'Set up OmniChat' ? 'next' : undefined;
}

// ---------------------------------------------------------------------------
// Screen 1: Choose how to run AI (Step 1 of 4)
// ---------------------------------------------------------------------------

interface ProviderChoice extends vscode.QuickPickItem {
  provider: ProviderId;
}

async function screenProvider(
  deps: ExtensionDeps,
  buffer: WizardBuffer,
): Promise<'next' | 'back' | undefined> {
  const ollamaCard: ProviderChoice = {
    provider: 'ollama',
    label: 'On this computer',
    detail:
      'Uses Ollama. Free and private, nothing leaves your machine. Downloads a model the first time (a few GB).',
    description: 'Recommended',
  };
  const qp = makePick<ProviderChoice>(
    'How do you want to run AI? (Step 1 of 4)',
    'OmniChat works with different AI providers. Pick the one that fits you. You can change this anytime.',
    [
      ollamaCard,
      {
        provider: 'openrouter',
        label: 'OpenRouter',
        detail:
          'Uses your OpenRouter account. Hundreds of models in the cloud, many with free options. Needs an API key.',
        description: 'Cloud',
      },
      {
        provider: 'custom',
        label: 'Another service',
        detail: 'Connect LM Studio, a server you run yourself, or any service that speaks the OpenAI API.',
        description: 'Depends on the service',
      },
    ],
  );
  if (buffer.provider) {
    qp.activeItems = qp.items.filter((i) => i.provider === buffer.provider);
  }
  // Detection runs in the background; the card badge updates when it lands.
  // No loading spinner as content: the screen is fully usable immediately.
  void detectOllama().then((d) => {
    if (d.running && d.models.length > 0) {
      ollamaCard.description = `Ollama found, ${d.models.length} model${d.models.length === 1 ? '' : 's'} ready`;
      qp.activeItems = [ollamaCard];
    } else if (d.installed) {
      ollamaCard.description = 'Ollama found, not running';
    }
    qp.items = [...qp.items];
  });
  const r = await showPick(qp, { back: true });
  if (!r) {
    return undefined;
  }
  if ('back' in r) {
    return 'back';
  }
  buffer.provider = r.picked.provider;
  return 'next';
}

// ---------------------------------------------------------------------------
// Screen 2A: Ollama path (Step 2 of 4)
// ---------------------------------------------------------------------------

type OllamaOutcome = 'next' | 'back' | 'check-again' | 'goto-openrouter' | undefined;

async function screenOllama(deps: ExtensionDeps, buffer: WizardBuffer): Promise<OllamaOutcome> {
  for (;;) {
    const d = await detectOllama();
    let r: OllamaOutcome;
    if (!d.installed) {
      r = await ollamaVariantNotInstalled(deps);
    } else if (!d.running) {
      r = await ollamaVariantNotRunning(deps, d);
    } else {
      r = await ollamaVariantRunning(deps, buffer, d);
    }
    if (r === 'check-again') {
      continue;
    }
    return r;
  }
}

interface VariantItem extends vscode.QuickPickItem {
  action: string;
}

async function ollamaVariantNotInstalled(deps: ExtensionDeps): Promise<OllamaOutcome> {
  const qp = makePick<VariantItem>(
    'Install Ollama first (Step 2 of 4)',
    'Ollama runs AI models on your computer. It is free and open source.',
    [
      { label: 'Download Ollama', detail: 'Opens the Ollama download page in your browser.', action: 'download' },
      { label: 'Use OpenRouter instead', detail: 'Chat with cloud models instead.', action: 'openrouter' },
      { label: 'Check again', detail: 'I installed Ollama, look again.', action: 'check' },
    ],
  );
  const r = await showPick(qp, { back: true });
  if (!r) {
    return undefined;
  }
  if ('back' in r) {
    return 'back';
  }
  switch (r.picked.action) {
    case 'download':
      // E1: the variant persists when the user returns without installing.
      await vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
      return 'check-again';
    case 'openrouter':
      return 'goto-openrouter';
    default:
      return 'check-again';
  }
}

async function ollamaVariantNotRunning(
  deps: ExtensionDeps,
  d: OllamaDetection,
): Promise<OllamaOutcome> {
  const qp = makePick<VariantItem>(
    'Ollama is installed but not running (Step 2 of 4)',
    'OmniChat needs Ollama running in the background. Start it now and forget about it.',
    [
      { label: 'Start Ollama', detail: 'Starts Ollama in the background.', action: 'start' },
      { label: 'Use OpenRouter instead', detail: 'Chat with cloud models instead.', action: 'openrouter' },
      { label: 'Check again', detail: 'I started Ollama myself, look again.', action: 'check' },
    ],
  );
  const r = await showPick(qp, { back: true });
  if (!r) {
    return undefined;
  }
  if ('back' in r) {
    return 'back';
  }
  switch (r.picked.action) {
    case 'start': {
      const ok = await startOllamaFlow(deps, d.baseUrl);
      if (ok) {
        return 'check-again';
      }
      // E2: Try again / Show me how to start it / Use OpenRouter instead.
      await presentError('OLLAMA_START_FAILED', deps, {
        baseUrl: d.baseUrl,
        retry: () => {
          void startOllamaFlow(deps, d.baseUrl);
        },
      });
      return 'check-again';
    }
    case 'openrouter':
      return 'goto-openrouter';
    default:
      return 'check-again';
  }
}

async function ollamaVariantRunning(
  deps: ExtensionDeps,
  buffer: WizardBuffer,
  d: OllamaDetection,
): Promise<OllamaOutcome> {
  interface ModelChoice extends vscode.QuickPickItem {
    action: string;
    modelId?: string;
  }
  const items: ModelChoice[] = [];
  if (d.models.length > 0) {
    for (const m of d.models) {
      items.push({ label: m.id, description: m.description, action: 'pick', modelId: m.id });
    }
    items.push(separator('') as ModelChoice);
    items.push({
      label: 'Download a starter model...',
      detail: 'qwen3:4b or qwen3:8b, one click',
      action: 'starter',
    });
  } else {
    for (const s of STARTER_MODELS) {
      items.push({
        label: s.id,
        detail: `${s.blurb} ${s.size}`,
        action: 'pull',
        modelId: s.id,
      });
    }
    items.push(separator('') as ModelChoice);
    items.push({
      label: 'Download in the background and continue',
      detail: 'Pick a model to download while you finish setup.',
      action: 'background',
    });
  }
  items.push({ label: 'Check again', action: 'check' });

  const qp = makePick<ModelChoice>(
    'Pick a model (Step 2 of 4)',
    d.models.length > 0
      ? 'These are already on your computer. Pick one to start, you can switch anytime.'
      : "Your computer doesn't have any models yet. Get one now:",
    items,
  );
  const r = await showPick(qp, { back: true });
  if (!r) {
    return undefined;
  }
  if ('back' in r) {
    return 'back';
  }
  const picked = r.picked;
  switch (picked.action) {
    case 'pick':
      buffer.ollamaModel = picked.modelId;
      return 'next';
    case 'starter': {
      const pulled = await starterPullList(deps, d);
      if (pulled) {
        buffer.ollamaModel = pulled;
        return 'next';
      }
      return 'check-again';
    }
    case 'pull': {
      const outcome = await pullStarterInline(deps, picked.modelId ?? '', d.baseUrl);
      if (outcome === 'done' || outcome === 'background') {
        buffer.ollamaModel = picked.modelId;
        return 'next';
      }
      if (outcome === 'failed') {
        await pullFailedPrompt(deps, picked.modelId ?? '', d);
      }
      return 'check-again';
    }
    case 'background': {
      const which = await pickStarterForBackground();
      if (!which) {
        return 'check-again';
      }
      // Host-owned pull with the notification only; Screen 3 waits for it.
      pullModelFlow(deps, which, d.baseUrl).then(
        () => undefined,
        () => undefined,
      );
      buffer.ollamaModel = which;
      return 'next';
    }
    default:
      return 'check-again';
  }
}

type InlinePullOutcome = 'done' | 'cancelled' | 'failed' | 'background';

/**
 * Inline wizard pull progress with a per-download cancel button (decision
 * #22, first surface). Closing the box does not cancel: the download
 * continues in the background via the shared pull operation.
 */
async function pullStarterInline(
  deps: ExtensionDeps,
  modelId: string,
  baseUrl: string,
): Promise<InlinePullOutcome> {
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem>();
  qp.title = `Downloading ${modelId} (Step 2 of 4)`;
  qp.placeholder = 'You can close this box and keep working. The download continues in the background.';
  const statusItem: vscode.QuickPickItem = { label: modelId, detail: 'Starting download...' };
  qp.items = [statusItem];
  const cancelButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('close'),
    tooltip: 'Cancel download',
  };
  qp.buttons = [cancelButton];
  qp.busy = true;
  qp.ignoreFocusOut = true;
  qp.canSelectMany = false;

  return new Promise((resolve) => {
    let settled = false;
    const done = (value: InlinePullOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      qp.dispose();
      resolve(value);
    };
    qp.onDidTriggerButton(() => {
      getPullOperation(modelId)?.controller.abort();
    });
    qp.onDidHide(() => {
      // Closing the box keeps the download running in the background.
      done(getPullOperation(modelId) ? 'background' : 'cancelled');
    });
    qp.show();
    pullModelFlow(deps, modelId, baseUrl, {
      onProgress: (p) => {
        statusItem.detail =
          p.total > 0
            ? `${formatBytes(p.completed)} of ${formatBytes(p.total)} downloaded`
            : p.status || 'Downloading...';
        qp.items = [{ ...statusItem }];
      },
    }).then(
      () => done('done'),
      (err: unknown) => done(isAbortError(err) ? 'cancelled' : 'failed'),
    );
  });
}

/** E3: "The download was interrupted." with Try again / Pick a smaller model. */
async function pullFailedPrompt(
  deps: ExtensionDeps,
  modelId: string,
  d: OllamaDetection,
): Promise<void> {
  const qp = makePick<VariantItem>('The download was interrupted.', 'The model download did not complete.', [
    { label: 'Try again', action: 'retry' },
    { label: 'Pick a smaller model', action: 'smaller' },
    { label: 'Use OpenRouter instead', action: 'openrouter' },
  ]);
  const r = await showPick(qp);
  if (!r || 'back' in r) {
    return;
  }
  switch (r.picked.action) {
    case 'retry': {
      const outcome = await pullStarterInline(deps, modelId, d.baseUrl);
      if (outcome === 'failed') {
        await pullFailedPrompt(deps, modelId, d);
      }
      return;
    }
    case 'openrouter':
      await deps.runSetupWizard({ startProvider: 'openrouter' });
      return;
    default:
      return;
  }
}

async function pickStarterForBackground(): Promise<string | undefined> {
  const qp = makePick<VariantItem>(
    'Download in the background',
    'Which model should download while you finish setup?',
    STARTER_MODELS.map((s) => ({
      label: s.id,
      detail: `${s.blurb} ${s.size}`,
      action: s.id,
    })),
  );
  const r = await showPick(qp, { back: true });
  if (!r || 'back' in r) {
    return undefined;
  }
  return r.picked.action;
}

// ---------------------------------------------------------------------------
// Screen 2B: OpenRouter path (Step 2 of 4)
// ---------------------------------------------------------------------------

async function screenOpenRouter(
  deps: ExtensionDeps,
  buffer: WizardBuffer,
): Promise<'next' | 'back' | undefined> {
  for (;;) {
    const keyResult = await enterApiKeyFlow('openrouter', {
      title: 'Connect OpenRouter (Step 2 of 4)',
    });
    if (!keyResult) {
      return undefined;
    }
    if ('back' in keyResult) {
      return 'back';
    }
    buffer.openrouterKey = keyResult.key;
    const picked = await pickOpenRouterModel(deps, {
      apiKey: keyResult.key,
      title: 'Pick a model (Step 2 of 4)',
    });
    if (!picked) {
      return undefined;
    }
    if (picked === 'back') {
      continue; // back to key entry
    }
    buffer.openrouterModel = picked.id;
    info(`wizard: openrouter model ${picked.id}`);
    return 'next';
  }
}

// ---------------------------------------------------------------------------
// Screen 2C: Another service (Step 2 of 4)
// ---------------------------------------------------------------------------

const CUSTOM_PRESETS = [
  { label: 'LM Studio', detail: 'Local server', url: 'http://localhost:1234/v1' },
  { label: 'llama.cpp server', detail: 'Local server', url: 'http://localhost:8080/v1' },
  { label: 'vLLM', detail: 'Local server', url: 'http://localhost:8000/v1' },
  { label: 'Custom URL...', detail: 'Enter any OpenAI-compatible address.', url: '' },
] as const;

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function screenCustom(
  deps: ExtensionDeps,
  buffer: WizardBuffer,
): Promise<'next' | 'back' | undefined> {
  // 1. Preset or custom URL (sanctioned typed field, decision #7).
  interface PresetItem extends vscode.QuickPickItem {
    url: string;
  }
  const presetPick = makePick<PresetItem>(
    'Connect another service (Step 2 of 4)',
    'Enter the address of your service. This works with LM Studio, a server you run yourself, or anything that speaks the OpenAI API.',
    CUSTOM_PRESETS.map((p) => ({ label: p.label, detail: p.detail, url: p.url })),
  );
  const presetResult = await showPick(presetPick, { back: true });
  if (!presetResult) {
    return undefined;
  }
  if ('back' in presetResult) {
    return 'back';
  }
  let url = presetResult.picked.url;
  if (!url) {
    const input = vscode.window.createInputBox();
    input.title = 'Connect another service (Step 2 of 4)';
    input.prompt = 'Enter the address of your service.';
    input.placeholder = 'http://localhost:1234';
    input.ignoreFocusOut = true;
    input.buttons = [vscode.QuickInputButtons.Back];
    const value = await new Promise<string | { back: true } | undefined>((resolve) => {
      let settled = false;
      const done = (v: string | { back: true } | undefined) => {
        if (settled) {
          return;
        }
        settled = true;
        input.dispose();
        resolve(v);
      };
      input.onDidTriggerButton((b) => {
        if (b === vscode.QuickInputButtons.Back) {
          done({ back: true });
        }
      });
      input.onDidAccept(() => {
        const v = input.value.trim();
        if (!isValidHttpUrl(v)) {
          input.validationMessage = 'Enter a valid address, like http://localhost:1234.';
          return;
        }
        done(v);
      });
      input.onDidHide(() => done(undefined));
      input.show();
    });
    if (!value) {
      return undefined;
    }
    if (typeof value !== 'string') {
      return 'back';
    }
    url = value;
  }
  const baseUrl = normalizeBaseUrl(url);

  // 2. Optional API key (sanctioned typed field, decision #7).
  const needKey = await pickYesNo('Does your service need an API key?');
  if (needKey === undefined) {
    return 'back';
  }
  let apiKey: string | undefined;
  if (needKey) {
    const keyResult = await enterApiKeyFlow('custom', {
      title: 'Connect another service (Step 2 of 4)',
      validate: (key) => new GenericOpenAICompatibleProvider(baseUrl, key).checkConnection(),
    });
    if (!keyResult) {
      return undefined;
    }
    if ('back' in keyResult) {
      return 'back';
    }
    apiKey = keyResult.key;
  }

  // 3. Check connection (E6 on failure).
  const provider = new GenericOpenAICompatibleProvider(baseUrl, apiKey);
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Checking connection...', cancellable: false },
      () => provider.checkConnection(),
    );
  } catch {
    const retry = await customUnreachablePrompt(baseUrl);
    if (retry === 'again') {
      return screenCustom(deps, buffer);
    }
    return retry === 'edit' ? 'back' : undefined;
  }

  // 4. Model list.
  const models = await provider.listModels();
  let modelId: string;
  if (models.length > 0) {
    const modelPick = makePick<VariantItem>(
      'Pick a model (Step 2 of 4)',
      `Models served by ${baseUrl}.`,
      models.map((m) => ({ label: m.label, description: m.id, action: m.id })),
    );
    const modelResult = await showPick(modelPick, { back: true });
    if (!modelResult) {
      return undefined;
    }
    if ('back' in modelResult) {
      return 'back';
    }
    modelId = modelResult.picked.action;
  } else {
    // Zero-typing: the service is reachable but lists no models, so there
    // is nothing to pick. Offer to fix the address instead of asking for a
    // typed model id.
    const emptyPick = makePick<VariantItem>(
      'Pick a model (Step 2 of 4)',
      'This service did not list any models. Check the address and try again.',
      [
        { label: 'Try again', action: 'again' },
        { label: 'Edit address', action: 'edit' },
      ],
    );
    const emptyResult = await showPick(emptyPick, { back: true });
    if (!emptyResult) {
      return undefined;
    }
    if ('back' in emptyResult) {
      return 'back';
    }
    return emptyResult.picked.action === 'again' ? screenCustom(deps, buffer) : 'back';
  }

  buffer.customBaseUrl = baseUrl;
  buffer.customKey = apiKey;
  buffer.customModel = modelId;
  return 'next';
}

async function pickYesNo(placeHolder: string): Promise<boolean | undefined> {
  const qp = makePick<VariantItem>('Connect another service (Step 2 of 4)', placeHolder, [
    { label: 'Yes', action: 'yes' },
    { label: 'No', action: 'no' },
  ]);
  const r = await showPick(qp, { back: true });
  if (!r || 'back' in r) {
    return undefined;
  }
  return r.picked.action === 'yes';
}

/** E6: "OmniChat couldn't reach {baseUrl}." (S2 #6: show the exact URL attempted.) */
async function customUnreachablePrompt(baseUrl: string): Promise<'again' | 'edit' | undefined> {
  const qp = makePick<VariantItem>(
    `OmniChat couldn't reach ${baseUrl}.`,
    'Check the address and try again.',
    [
      { label: 'Try again', action: 'again' },
      { label: 'Edit address', action: 'edit' },
    ],
  );
  const r = await showPick(qp);
  if (!r || 'back' in r) {
    return undefined;
  }
  return r.picked.action as 'again' | 'edit';
}

// ---------------------------------------------------------------------------
// Screen 3: Test (Step 3 of 4)
// ---------------------------------------------------------------------------

function buildBufferProvider(buffer: WizardBuffer): LLMProvider {
  const settings = readSettings();
  switch (buffer.provider) {
    case 'ollama':
      return new OllamaProvider(settings.ollama.baseUrl);
    case 'openrouter':
      return new OpenRouterProvider(buffer.openrouterKey ?? '');
    case 'custom':
      return new GenericOpenAICompatibleProvider(buffer.customBaseUrl ?? '', buffer.customKey);
  }
}

function bufferModel(buffer: WizardBuffer): string {
  switch (buffer.provider) {
    case 'ollama':
      return buffer.ollamaModel ?? '';
    case 'openrouter':
      return buffer.openrouterModel ?? '';
    case 'custom':
      return buffer.customModel ?? '';
  }
}

/**
 * A settings snapshot matching the wizard buffer, for per-provider privacy
 * labels on the completion screen (the buffer is not committed yet). The
 * Ollama host comes from real settings so a non-localhost host edits via
 * recovery shows the Network label, not the local one.
 */
function bufferSettings(buffer: WizardBuffer): OmniChatSettings {
  return applyDefaults({
    provider: buffer.provider,
    ollama: {
      baseUrl: readSettings().ollama.baseUrl,
      model: buffer.ollamaModel ?? '',
    },
    openrouter: {
      model: buffer.openrouterModel ?? '',
    },
    custom: {
      baseUrl: buffer.customBaseUrl ?? '',
      model: buffer.customModel ?? '',
    },
  });
}

interface TestAttempt {
  ok: boolean;
  reply: string;
  code?: 'NETWORK_ERROR' | 'OLLAMA_UNREACHABLE' | 'UNAUTHORIZED' | 'TIMEOUT' | 'UNKNOWN';
  err?: unknown;
}

async function attemptTest(deps: ExtensionDeps, buffer: WizardBuffer): Promise<TestAttempt> {
  // A background pull may still be running; the test waits for it.
  if (buffer.provider === 'ollama' && buffer.ollamaModel) {
    const op = getPullOperation(buffer.ollamaModel);
    if (op) {
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Waiting for ${buffer.ollamaModel} to finish downloading...`,
            cancellable: false,
          },
          () => op.done,
        );
      } catch {
        return { ok: false, reply: '', code: 'UNKNOWN' };
      }
    }
  }
  const provider = buildBufferProvider(buffer);
  const model = bufferModel(buffer);
  let reply = '';
  try {
    const controller = new AbortController();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Saying hello...', cancellable: true },
      async (_progress, token) => {
        token.onCancellationRequested(() => controller.abort());
        const stream = provider.chatStream({
          model,
          messages: [{ role: 'user', content: 'Say hello in one short sentence.' }],
          signal: controller.signal,
        });
        for await (const ev of stream) {
          if (ev.type === 'token') {
            reply += ev.text;
          }
        }
      },
    );
  } catch (err) {
    if (isAbortError(err)) {
      return { ok: false, reply: '', code: 'UNKNOWN', err };
    }
    const code =
      err instanceof OmniChatError &&
      (err.code === 'OLLAMA_UNREACHABLE' ||
        err.code === 'UNAUTHORIZED' ||
        err.code === 'TIMEOUT' ||
        err.code === 'NETWORK_ERROR')
        ? err.code
        : 'UNKNOWN';
    return { ok: false, reply: '', code, err };
  }
  return { ok: true, reply };
}

async function screenTest(
  deps: ExtensionDeps,
  buffer: WizardBuffer,
  finish: () => Promise<void>,
): Promise<'done' | 'back' | undefined> {
  const attempt = await attemptTest(deps, buffer);
  if (attempt.ok) {
    const preview = attempt.reply.trim().slice(0, 160) || 'OK';
    // S1 #2 (D12): the completion screen must state the selected provider,
    // the selected model, and the per-provider privacy label.
    const summarySettings = bufferSettings(buffer);
    const qp = makePick<VariantItem>(
      'Everything works.',
      `${providerDisplayName(buffer.provider)} · ${bufferModel(buffer)} · ${privacyTag(summarySettings)}. ${privacyLabelFor(summarySettings)}`,
      [{ label: 'Start chatting', detail: `OmniChat said: "${preview}"`, action: 'chat' }],
    );
    const r = await showPick(qp, { back: true });
    if (!r) {
      return undefined;
    }
    return 'back' in r ? 'back' : 'done';
  }
  if (attempt.err && isAbortError(attempt.err)) {
    return undefined;
  }
  const finished = { value: false };
  const model = bufferModel(buffer);
  const settings = readSettings();
  logErrorDetail(attempt.code ?? 'UNKNOWN', attempt.err);
  await presentError(attempt.code ?? 'UNKNOWN', deps, {
    model,
    baseUrl: buffer.provider === 'ollama' ? settings.ollama.baseUrl : buffer.customBaseUrl,
    providerId: buffer.provider,
    providerDisplayName: providerDisplayName(buffer.provider),
    details: attempt.err instanceof Error ? attempt.err.message : String(attempt.err),
    retry: async () => {
      const r = await screenTest(deps, buffer, finish);
      if (r === 'done') {
        await finish();
        finished.value = true;
      }
    },
  });
  return finished.value ? 'done' : 'back';
}

// ---------------------------------------------------------------------------
// Done: commit (Screen 4)
// ---------------------------------------------------------------------------

async function commitWizard(deps: ExtensionDeps, buffer: WizardBuffer): Promise<void> {
  const { ctx } = deps;
  await updateSetting('provider', buffer.provider);
  if (buffer.provider === 'ollama') {
    if (buffer.ollamaModel) {
      await updateSetting('ollama.model', buffer.ollamaModel);
    }
  } else if (buffer.provider === 'openrouter') {
    if (buffer.openrouterKey) {
      await storeSecret(ctx, OPENROUTER_API_KEY, buffer.openrouterKey);
    }
    if (buffer.openrouterModel) {
      await updateSetting('openrouter.model', buffer.openrouterModel);
    }
  } else {
    if (buffer.customBaseUrl) {
      await updateSetting('custom.baseUrl', buffer.customBaseUrl);
    }
    if (buffer.customModel) {
      await updateSetting('custom.model', buffer.customModel);
    }
    if (buffer.customKey) {
      await storeSecret(ctx, CUSTOM_API_KEY, buffer.customKey);
      await updateSetting('custom.apiKeyRequired', true);
    }
  }
  invalidateProviderCache();
  await writeWizardState(ctx, { status: 'ready', furthestStep: 3, provider: buffer.provider });
  info(`wizard complete: ${providerDisplayName(buffer.provider)} ${bufferModel(buffer)}`);
  deps.refreshSurfaces();
  await vscode.window.showInformationMessage('OmniChat is ready. Ask anything.');
  deps.revealChat();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runSetupWizard(
  deps: ExtensionDeps,
  opts: WizardOptions = {},
): Promise<void> {
  const persisted = readWizardState(deps.ctx);
  const buffer: WizardBuffer = {
    provider: opts.startProvider ?? persisted.provider ?? 'ollama',
  };
  if (opts.startProvider) {
    await markWizardStep(deps.ctx, 1, buffer.provider);
  }
  let step = resolveInitialStep(persisted, { startProvider: opts.startProvider });

  let committed = false;
  const finish = async () => {
    if (!committed) {
      committed = true;
      await commitWizard(deps, buffer);
    }
  };

  for (;;) {
    if (step === 0) {
      const r = await screenWelcome();
      if (r !== 'next') {
        return; // "I'll do this later" or dismiss: config untouched.
      }
      await markWizardStep(deps.ctx, 0);
      step = 1;
    } else if (step === 1) {
      const r = await screenProvider(deps, buffer);
      if (r === undefined) {
        return;
      }
      if (r === 'back') {
        step = 0;
        continue;
      }
      await markWizardStep(deps.ctx, 1, buffer.provider);
      step = 2;
    } else if (step === 2) {
      const r =
        buffer.provider === 'ollama'
          ? await screenOllama(deps, buffer)
          : buffer.provider === 'openrouter'
            ? await screenOpenRouter(deps, buffer)
            : await screenCustom(deps, buffer);
      if (r === undefined) {
        return;
      }
      if (r === 'back') {
        step = 1;
        continue;
      }
      if (r === 'goto-openrouter') {
        buffer.provider = 'openrouter';
        await markWizardStep(deps.ctx, 1, buffer.provider);
        continue; // stay on step 2, OpenRouter path
      }
      await markWizardStep(deps.ctx, 2, buffer.provider);
      step = 3;
    } else {
      const r = await screenTest(deps, buffer, finish);
      if (r === undefined) {
        return;
      }
      if (r === 'back') {
        step = 2;
        continue;
      }
      await finish();
      return;
    }
  }
}
