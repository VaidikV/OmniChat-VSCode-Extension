/**
 * Grouped model and provider switcher (FR-10, decision #21).
 *
 * "OmniChat: Switch model or provider" opens one QuickPick grouped by
 * provider: Ollama installed models with sizes, OpenRouter models with the
 * pinned Popular group / vendor groups / pricing hints / Cloud tag, and the
 * custom endpoint's models. Footer: "Add or change provider..." (reopens the
 * wizard) and "Refresh model list". The old free-text Set Model command is
 * gone (decision #6); typing in this picker is search-only filtering.
 */

import * as vscode from 'vscode';
import { invalidateProviderCache } from '../providers/factory.js';
import { formatBytes } from '../providers/ollama.js';
import { OpenRouterProvider } from '../providers/openrouter.js';
import type { ModelInfo, ProviderId } from '../providers/types.js';
import { OPENROUTER_API_KEY, optionalSecret, storeSecret } from '../state/secrets.js';
import { readSettings } from '../state/settings.js';
import { info } from '../util/log.js';
import type { ExtensionDeps, ModelPickerOptions } from './deps.js';
import { presentError } from './errorPresenter.js';
import {
  detectOllama,
  enterApiKeyFlow,
  getPullOperation,
  pullModelFlow,
  startOllamaFlow,
  type OllamaDetection,
} from './flows.js';
import {
  activeModel,
  modelSettingKey,
  providerDisplayName,
  updateSetting,
} from './settingsUtil.js';

const OPENROUTER_CACHE_KEY = 'omnichat.openrouter.modelsCache';
const OPENROUTER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Curated Popular group (decision #21). PM owns the contents; entries are
 * matched against the live model list, so stale ids simply do not appear.
 * The paid openai/gpt-oss-20b is the first-run default (decision #24).
 */
const POPULAR_OPENROUTER_IDS = [
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'google/gemini-2.5-flash',
  'anthropic/claude-sonnet-4',
  'meta-llama/llama-3.3-70b-instruct',
  'deepseek/deepseek-chat',
];

/** Starter models for one-click ollama pull (decisions #23, #31). */
export const STARTER_MODELS = [
  { id: 'qwen3:4b', blurb: 'Fast, good for quick questions.', size: 'About 2.5 GB download.' },
  { id: 'qwen3:8b', blurb: 'Slower, better answers.', size: 'About 5.2 GB download.' },
] as const;

interface CacheEntry {
  at: number;
  models: ModelInfo[];
}

/**
 * OpenRouter model list with a 24h globalState cache (technical design
 * section 2). Refresh bypasses the cache. listModels() is public on
 * OpenRouter, so no key is needed for the fetch itself.
 */
export async function getOpenRouterModels(
  deps: ExtensionDeps,
  opts: { refresh?: boolean; apiKey?: string } = {},
): Promise<ModelInfo[]> {
  if (!opts.refresh) {
    const cached = deps.ctx.globalState.get<CacheEntry>(OPENROUTER_CACHE_KEY);
    if (cached && Date.now() - cached.at < OPENROUTER_CACHE_TTL_MS) {
      return cached.models;
    }
  }
  const key = opts.apiKey ?? (await optionalSecret(deps.ctx, OPENROUTER_API_KEY)) ?? '';
  const models = await new OpenRouterProvider(key).listModels();
  await deps.ctx.globalState.update(OPENROUTER_CACHE_KEY, { at: Date.now(), models });
  return models;
}

export async function clearOpenRouterCache(ctx: vscode.ExtensionContext): Promise<void> {
  await ctx.globalState.update(OPENROUTER_CACHE_KEY, undefined);
}

// ---------------------------------------------------------------------------
// Item model
// ---------------------------------------------------------------------------

type PickerItem =
  | (vscode.QuickPickItem & { choice: 'model'; provider: ProviderId; modelId: string })
  | (vscode.QuickPickItem & { choice: 'command'; command: string })
  | vscode.QuickPickItem;

function isSeparatorItem(item: vscode.QuickPickItem): boolean {
  return (item as vscode.QuickPickItem).kind === vscode.QuickPickItemKind.Separator;
}

function isModelChoice(
  item: PickerItem,
): item is vscode.QuickPickItem & { choice: 'model'; provider: ProviderId; modelId: string } {
  return (item as { choice?: string }).choice === 'model';
}

function isCommandChoice(
  item: PickerItem,
): item is vscode.QuickPickItem & { choice: 'command'; command: string } {
  return (item as { choice?: string }).choice === 'command';
}

function separator(label: string): vscode.QuickPickItem {
  return { label, kind: vscode.QuickPickItemKind.Separator };
}

function openRouterItemLabel(m: ModelInfo, currentId: string): GroupedModelItem {
  const hint = m.description ? ` · ${m.description}` : '';
  return {
    label: m.label,
    description: `${m.id}${hint}`,
    picked: m.id === currentId,
    model: m,
  };
}

/** Picker item carrying its ModelInfo (separators have no model). */
export interface GroupedModelItem extends vscode.QuickPickItem {
  model?: ModelInfo;
}

/**
 * OpenRouter items per decision #21: pinned Popular group first, then
 * vendor-prefixed groups (openai/, anthropic/, google/, ...), pricing hints
 * in every description line, Cloud tag on the provider group.
 */
export function groupOpenRouterItems(
  models: ModelInfo[],
  currentId: string,
): GroupedModelItem[] {
  const items: GroupedModelItem[] = [];
  const byId = new Map(models.map((m) => [m.id, m]));
  const popular = POPULAR_OPENROUTER_IDS.map((id) => byId.get(id)).filter(
    (m): m is ModelInfo => !!m,
  );
  const popularIds = new Set(popular.map((m) => m.id));
  if (popular.length > 0) {
    items.push(separator('Popular'));
    for (const m of popular) {
      items.push(openRouterItemLabel(m, currentId));
    }
  }
  const vendors = new Map<string, ModelInfo[]>();
  for (const m of models) {
    if (popularIds.has(m.id)) {
      continue;
    }
    const vendor = m.id.includes('/') ? m.id.split('/')[0] : 'other';
    const list = vendors.get(vendor) ?? [];
    list.push(m);
    vendors.set(vendor, list);
  }
  for (const [vendor, list] of [...vendors.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    items.push(separator(`${vendor}/`));
    for (const m of list) {
      items.push(openRouterItemLabel(m, currentId));
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Main switcher
// ---------------------------------------------------------------------------

export async function openModelPicker(
  deps: ExtensionDeps,
  _opts: ModelPickerOptions = {},
): Promise<void> {
  const settings = readSettings();
  const detection = await detectOllama();
  const items: PickerItem[] = [];

  // Group: On this computer (Ollama)
  items.push(separator('On this computer (Ollama) · Private'));
  if (detection.running) {
    if (detection.models.length > 0) {
      for (const m of detection.models) {
        items.push({
          choice: 'model',
          provider: 'ollama',
          modelId: m.id,
          label: m.id,
          description: m.description,
          picked: m.id === settings.ollama.model,
        });
      }
    }
    items.push({
      choice: 'command',
      command: 'pull-starter',
      label: 'Download a starter model...',
      description: 'qwen3:4b or qwen3:8b, one click',
    });
  } else if (detection.installed) {
    items.push({
      choice: 'command',
      command: 'start-ollama',
      label: 'Start Ollama',
      description: 'Ollama is installed but not running',
    });
  } else {
    items.push({
      choice: 'command',
      command: 'open-setup',
      label: 'Ollama not found',
      description: 'Run setup to install it or pick another provider',
    });
  }

  // Group: OpenRouter (Cloud)
  items.push(separator('OpenRouter · Cloud'));
  const hasKey = (await optionalSecret(deps.ctx, OPENROUTER_API_KEY)) !== undefined;
  if (!hasKey) {
    items.push({
      choice: 'command',
      command: 'connect-openrouter',
      label: 'Connect OpenRouter...',
      description: 'Paste your API key, then pick a model',
    });
  } else {
    try {
      const models = await getOpenRouterModels(deps);
      for (const g of groupOpenRouterItems(models, settings.openrouter.model)) {
        if (g.model) {
          items.push({
            choice: 'model',
            provider: 'openrouter',
            modelId: g.model.id,
            label: g.label,
            description: g.description,
            picked: g.model.id === settings.openrouter.model,
          });
        } else {
          items.push(g);
        }
      }
    } catch {
      items.push({
        choice: 'command',
        command: 'refresh',
        label: 'Could not load the OpenRouter model list',
        description: 'Select to try again',
      });
    }
  }

  // Group: Another service (Custom)
  items.push(separator('Another service · Custom'));
  if (!settings.custom.baseUrl.trim()) {
    items.push({
      choice: 'command',
      command: 'connect-custom',
      label: 'Connect a service...',
      description: 'LM Studio, vLLM, llama.cpp server, ...',
    });
  } else {
    items.push({
      choice: 'model',
      provider: 'custom',
      modelId: settings.custom.model,
      label: settings.custom.model || '(no model configured)',
      description: settings.custom.baseUrl,
      picked: true,
    });
  }

  // Footer
  items.push(separator(''));
  items.push({ choice: 'command', command: 'open-setup', label: 'Add or change provider...' });
  items.push({ choice: 'command', command: 'refresh', label: 'Refresh model list' });

  const qp = vscode.window.createQuickPick<PickerItem>();
  qp.title = 'Switch model or provider';
  qp.placeholder = 'Search models';
  qp.items = items;
  qp.canSelectMany = false;
  qp.matchOnDescription = true;

  const chosen = await new Promise<PickerItem | undefined>((resolve) => {
    let settled = false;
    const done = (value: PickerItem | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    qp.onDidAccept(() => {
      const item = qp.selectedItems[0];
      qp.hide();
      done(!item || isSeparatorItem(item) ? undefined : item);
    });
    qp.onDidHide(() => {
      qp.dispose();
      done(undefined);
    });
    qp.show();
  });

  if (!chosen || isSeparatorItem(chosen)) {
    return;
  }
  if (isModelChoice(chosen)) {
    await selectModel(deps, chosen.provider, chosen.modelId);
    return;
  }
  if (!isCommandChoice(chosen)) {
    return;
  }
  switch (chosen.command) {
    case 'start-ollama': {
      const ok = await startOllamaFlow(deps, detection.baseUrl);
      if (ok) {
        await openModelPicker(deps);
      } else {
        await presentError('OLLAMA_START_FAILED', deps, { baseUrl: detection.baseUrl });
      }
      return;
    }
    case 'connect-openrouter': {
      const result = await enterApiKeyFlow('openrouter');
      if (result && !('back' in result)) {
        await storeSecret(deps.ctx, OPENROUTER_API_KEY, result.key);
        invalidateProviderCache();
        deps.refreshSurfaces();
        await openModelPicker(deps);
      }
      return;
    }
    case 'connect-custom': {
      await deps.runSetupWizard({ startProvider: 'custom' });
      return;
    }
    case 'pull-starter': {
      await starterPullList(deps, detection);
      return;
    }
    case 'open-setup': {
      await deps.runSetupWizard();
      return;
    }
    case 'refresh': {
      await clearOpenRouterCache(deps.ctx);
      await openModelPicker(deps);
      return;
    }
  }
}

/** Persist a provider+model selection (mid-chat switches keep history). */
export async function selectModel(
  deps: ExtensionDeps,
  provider: ProviderId,
  modelId: string,
): Promise<void> {
  await updateSetting('provider', provider);
  await updateSetting(modelSettingKey(provider), modelId);
  invalidateProviderCache();
  deps.refreshSurfaces();
  info(`model selected: ${providerDisplayName(provider)} ${modelId}`);
}

// ---------------------------------------------------------------------------
// Starter-model pull list (one-click qwen3:4b / qwen3:8b)
// ---------------------------------------------------------------------------

/**
 * QuickPick listing the starter models with Download buttons and inline
 * progress plus per-download cancel. Used by the wizard and the switcher.
 * Returns the pulled model id, or undefined when nothing was pulled.
 */
export async function starterPullList(
  deps: ExtensionDeps,
  detection: OllamaDetection,
): Promise<string | undefined> {
  interface StarterItem extends vscode.QuickPickItem {
    modelId: string;
  }
  const qp = vscode.window.createQuickPick<StarterItem>();
  qp.title = 'Download a starter model';
  qp.placeholder = 'Pick a model to download with one click';
  const downloadButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('cloud-download'),
    tooltip: 'Download',
  };
  const cancelButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('close'),
    tooltip: 'Cancel download',
  };
  qp.items = STARTER_MODELS.map((s) => ({
    label: s.id,
    detail: `${s.blurb} ${s.size}`,
    modelId: s.id,
    buttons: [downloadButton],
  }));
  qp.canSelectMany = false;

  return new Promise((resolve) => {
    let settled = false;
    let downloading: string | undefined;
    const done = (value: string | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      qp.dispose();
      resolve(value);
    };
    const startDownload = async (modelId: string) => {
      if (downloading) {
        return;
      }
      downloading = modelId;
      qp.busy = true;
      qp.buttons = [cancelButton];
      qp.title = `Downloading ${modelId}`;
      const updateItem = (detail: string) => {
        qp.items = qp.items.map((item) =>
          item.modelId === modelId ? { ...item, detail, buttons: [] } : item,
        );
      };
      try {
        await pullModelFlow(deps, modelId, detection.baseUrl, {
          onProgress: (p) => {
            updateItem(
              p.total > 0
                ? `${formatBytes(p.completed)} of ${formatBytes(p.total)} downloaded`
                : p.status || 'Downloading...',
            );
          },
        });
        done(modelId);
      } catch {
        qp.busy = false;
        qp.buttons = [];
        qp.title = 'Download a starter model';
        updateItem('The download was interrupted. Pick the model to try again.');
        downloading = undefined;
      }
    };
    qp.onDidTriggerItemButton((e) => {
      void startDownload((e.item as StarterItem).modelId);
    });
    qp.onDidTriggerButton((button) => {
      if (button === cancelButton && downloading) {
        getPullOperation(downloading)?.controller.abort();
      }
    });
    qp.onDidAccept(() => {
      const item = qp.selectedItems[0] as StarterItem | undefined;
      if (item && !downloading) {
        void startDownload(item.modelId);
      }
    });
    qp.onDidHide(() => done(undefined));
    qp.show();
  });
}

// ---------------------------------------------------------------------------
// OpenRouter picker for the wizard (decision #21)
// ---------------------------------------------------------------------------

/**
 * Grouped OpenRouter model picker used by the setup wizard's OpenRouter path.
 * Returns the chosen ModelInfo, 'back', or undefined (cancelled).
 */
export async function pickOpenRouterModel(
  deps: ExtensionDeps,
  opts: { apiKey?: string; title?: string; currentId?: string } = {},
): Promise<ModelInfo | 'back' | undefined> {
  const currentId = opts.currentId ?? readSettings().openrouter.model;
  let models: ModelInfo[];
  try {
    models = await getOpenRouterModels(deps, { apiKey: opts.apiKey });
  } catch {
    await presentError('NETWORK_ERROR', deps, {
      providerId: 'openrouter',
      providerDisplayName: 'OpenRouter',
      retry: () => {
        void pickOpenRouterModel(deps, opts);
      },
    });
    return undefined;
  }
  interface ModelItem extends vscode.QuickPickItem {
    model?: ModelInfo;
    command?: 'refresh' | 'back';
  }
  const buildItems = (): ModelItem[] => [
    ...groupOpenRouterItems(models, currentId),
    separator(''),
    { label: 'Refresh list', command: 'refresh' },
  ];
  const qp = vscode.window.createQuickPick<ModelItem>();
  qp.title = opts.title ?? 'Pick a model';
  qp.placeholder = 'Search models';
  qp.items = buildItems();
  qp.buttons = [vscode.QuickInputButtons.Back];
  qp.canSelectMany = false;
  qp.matchOnDescription = true;
  const def = models.find((m) => m.id === 'openai/gpt-oss-20b');
  if (def) {
    qp.activeItems = qp.items.filter((i) => (i as ModelItem).model?.id === def.id);
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (value: ModelInfo | 'back' | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      qp.dispose();
      resolve(value);
    };
    qp.onDidTriggerButton((b) => {
      if (b === vscode.QuickInputButtons.Back) {
        qp.hide();
        done('back');
      }
    });
    qp.onDidAccept(() => {
      const item = qp.selectedItems[0];
      if (!item || isSeparatorItem(item)) {
        return;
      }
      if (item.command === 'refresh') {
        qp.busy = true;
        void (async () => {
          try {
            models = await getOpenRouterModels(deps, { refresh: true, apiKey: opts.apiKey });
            qp.items = buildItems();
          } catch {
            // Keep the stale list; the error was already surfaced on open.
          } finally {
            qp.busy = false;
          }
        })();
        return;
      }
      qp.hide();
      done(item.model);
    });
    qp.onDidHide(() => done(undefined));
    qp.show();
  });
}
