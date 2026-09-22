/**
 * Error presentation (EE-3).
 *
 * Every OmniChatError code maps to a QuickPick carrying the recoveryFor()
 * title/message plus its fix actions, or to an in-chat error banner (the E7
 * pattern) with the same actions surfaced via the webview's errorAction
 * message. Raw errors and stack traces never reach the user; technical
 * details go to the Output panel and to copy-details.
 */

import * as vscode from 'vscode';
import {
  OmniChatError,
  recoveryFor,
  type ErrorCode,
  type RecoveryActionId,
} from '../providers/errors.js';
import { createProvider, invalidateProviderCache } from '../providers/factory.js';
import { GenericOpenAICompatibleProvider } from '../providers/genericOpenAI.js';
import { checkOllamaStatus } from '../providers/ollama.js';
import {
  CUSTOM_API_KEY,
  OPENROUTER_API_KEY,
  storeSecret,
} from '../state/secrets.js';
import { readSettings } from '../state/settings.js';
import { error as logError } from '../util/log.js';
import type { ExtensionDeps } from './deps.js';
import {
  detectOllama,
  enterApiKeyFlow,
  pullModelFlow,
  showStartGuide,
  startOllamaFlow,
  type KeyProviderId,
} from './flows.js';
import {
  activeModel,
  providerDisplayName,
  updateSetting,
} from './settingsUtil.js';
import type { ProviderId } from '../providers/types.js';

export interface RecoveryActionContext {
  model?: string;
  baseUrl?: string;
  providerId?: ProviderId;
  providerDisplayName?: string;
  /** Retry the failed operation. */
  retry?: () => Promise<void> | void;
  /** Technical details for copy-details (never shown unprompted). */
  details?: string;
}

export interface ChatErrorPayload {
  code: ErrorCode;
  title: string;
  message: string;
  actions: Array<{ id: string; label: string }>;
}

/**
 * Build the webview error-banner payload (E7 pattern) for an error code.
 * The webview renders the same recovery buttons; clicks come back as
 * {command:'errorAction', id} and run through executeRecoveryAction().
 */
export function chatErrorPayload(
  code: ErrorCode,
  actx: RecoveryActionContext = {},
): ChatErrorPayload {
  const settings = readSettings();
  const recovery = recoveryFor(code, {
    model: actx.model ?? activeModel(settings) ?? undefined,
    baseUrl: actx.baseUrl,
    providerDisplayName:
      actx.providerDisplayName ?? providerDisplayName(actx.providerId ?? settings.provider),
  });
  return {
    code,
    title: recovery.title,
    message: `${recovery.title}. ${recovery.message}`,
    actions: recovery.actions.map((a) => ({ id: a.id, label: a.label })),
  };
}

/** Log the technical detail (Output panel) without leaking secrets. */
export function logErrorDetail(code: ErrorCode, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  logError(`${code}: ${detail}`);
}

/**
 * QuickPick presentation: title + message with the recovery buttons.
 * Picking a button executes it via executeRecoveryAction().
 */
export async function presentError(
  code: ErrorCode,
  deps: ExtensionDeps,
  actx: RecoveryActionContext = {},
): Promise<void> {
  const payload = chatErrorPayload(code, actx);
  interface ActionItem extends vscode.QuickPickItem {
    actionId: RecoveryActionId;
  }
  const qp = vscode.window.createQuickPick<ActionItem>();
  qp.title = payload.title;
  qp.placeholder = payload.message;
  qp.items = payload.actions.map((a) => ({
    label: a.label,
    actionId: a.id as RecoveryActionId,
  }));
  qp.canSelectMany = false;
  const chosen = await new Promise<ActionItem | undefined>((resolve) => {
    let settled = false;
    const done = (value: ActionItem | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    qp.onDidAccept(() => {
      const item = qp.selectedItems[0];
      qp.hide();
      done(item);
    });
    qp.onDidHide(() => {
      qp.dispose();
      done(undefined);
    });
    qp.show();
  });
  if (chosen) {
    await executeRecoveryAction(chosen.actionId, deps, actx);
  }
}

/** Host-side implementation of the 16 recovery action ids. */
export async function executeRecoveryAction(
  id: RecoveryActionId,
  deps: ExtensionDeps,
  actx: RecoveryActionContext = {},
): Promise<void> {
  const settings = readSettings();
  switch (id) {
    case 'start-ollama': {
      const baseUrl = actx.baseUrl ?? settings.ollama.baseUrl;
      const ok = await startOllamaFlow(deps, baseUrl);
      if (ok) {
        if (actx.retry) {
          await actx.retry();
        }
      } else {
        await presentError('OLLAMA_START_FAILED', deps, {
          ...actx,
          baseUrl,
          retry: () => executeRecoveryAction('start-ollama', deps, actx),
        });
      }
      return;
    }
    case 'retry': {
      if (actx.retry) {
        await actx.retry();
      } else {
        await vscode.window.showInformationMessage('Nothing to retry right now.');
      }
      return;
    }
    case 'open-setup': {
      await deps.runSetupWizard();
      return;
    }
    case 'switch-provider':
    case 'pick-model': {
      await deps.openModelPicker();
      return;
    }
    case 'pull-model': {
      const model = actx.model ?? activeModel(settings);
      if (!model) {
        await vscode.window.showInformationMessage('No model selected to download.');
        return;
      }
      try {
        await pullModelFlow(deps, model, actx.baseUrl);
      } catch (err) {
        await presentError('PULL_FAILED', deps, {
          ...actx,
          model,
          retry: () => executeRecoveryAction('pull-model', deps, actx),
        });
      }
      return;
    }
    case 'reenter-key': {
      const providerId: KeyProviderId = actx.providerId === 'custom' ? 'custom' : 'openrouter';
      const result = await enterApiKeyFlow(providerId, {
        title: providerId === 'openrouter' ? 'Re-enter OpenRouter API key' : 'Re-enter service API key',
      });
      if (!result || 'back' in result) {
        return;
      }
      await storeSecret(
        deps.ctx,
        providerId === 'custom' ? CUSTOM_API_KEY : OPENROUTER_API_KEY,
        result.key,
      );
      invalidateProviderCache();
      deps.refreshSurfaces();
      if (actx.retry) {
        await actx.retry();
      }
      return;
    }
    case 'get-key': {
      await vscode.env.openExternal(vscode.Uri.parse('https://openrouter.ai/keys'));
      return;
    }
    case 'open-billing': {
      await vscode.env.openExternal(vscode.Uri.parse('https://openrouter.ai/settings/billing'));
      return;
    }
    case 'copy-details': {
      await vscode.env.clipboard.writeText(actx.details ?? 'No technical details available.');
      await vscode.window.showInformationMessage('Error details copied to the clipboard.');
      return;
    }
    case 'use-openrouter': {
      await updateSetting('provider', 'openrouter');
      invalidateProviderCache();
      deps.refreshSurfaces();
      await deps.runSetupWizard({ startProvider: 'openrouter' });
      return;
    }
    case 'use-ollama': {
      await updateSetting('provider', 'ollama');
      invalidateProviderCache();
      deps.refreshSurfaces();
      await deps.runSetupWizard({ startProvider: 'ollama' });
      return;
    }
    case 'show-start-guide': {
      await showStartGuide();
      return;
    }
    case 'edit-endpoint': {
      await editEndpointFlow(deps, actx);
      return;
    }
    case 'test-connection': {
      await testConnectionFlow(deps);
      return;
    }
    case 'check-again': {
      const d = await detectOllama(actx.baseUrl);
      const summary = d.running
        ? d.models.length > 0
          ? `Ollama is running with ${d.models.length} model${d.models.length === 1 ? '' : 's'}.`
          : 'Ollama is running, but no models are installed yet.'
        : d.installed
          ? 'Ollama is installed but not running.'
          : 'Ollama is not installed.';
      await vscode.window.showInformationMessage(summary);
      if (actx.retry) {
        await actx.retry();
      }
      return;
    }
  }
}

/** Edit the endpoint URL for the Ollama or custom provider, then test it. */
async function editEndpointFlow(
  deps: ExtensionDeps,
  actx: RecoveryActionContext,
): Promise<void> {
  const settings = readSettings();
  const providerId = actx.providerId ?? settings.provider;
  if (providerId === 'openrouter') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'omnichat');
    return;
  }
  const key = providerId === 'ollama' ? 'ollama.baseUrl' : 'custom.baseUrl';
  const current = providerId === 'ollama' ? settings.ollama.baseUrl : settings.custom.baseUrl;
  const value = await vscode.window.showInputBox({
    title: 'Edit endpoint',
    prompt: 'Enter the service address.',
    value: current,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Enter an address.'),
  });
  if (!value) {
    return;
  }
  const trimmed = value.trim();
  try {
    if (providerId === 'ollama') {
      const status = await checkOllamaStatus(trimmed);
      if (!status.running) {
        throw new OmniChatError('OLLAMA_UNREACHABLE', 'ollama', { baseUrl: trimmed });
      }
    } else {
      await new GenericOpenAICompatibleProvider(trimmed).checkConnection();
    }
  } catch {
    await vscode.window.showWarningMessage(
      'OmniChat could not reach that address. The address was not saved.',
    );
    return;
  }
  await updateSetting(key, trimmed);
  invalidateProviderCache();
  deps.refreshSurfaces();
  if (actx.retry) {
    await actx.retry();
  }
}

/** Re-run checkConnection() for the current provider and report the result. */
async function testConnectionFlow(deps: ExtensionDeps): Promise<void> {
  try {
    const provider = await createProvider(deps.ctx);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Testing connection...', cancellable: false },
      () => provider.checkConnection(),
    );
    await vscode.window.showInformationMessage('Connection looks good.');
  } catch (err) {
    const code = err instanceof OmniChatError ? err.code : 'UNKNOWN';
    const payload = chatErrorPayload(code, { providerDisplayName: providerDisplayName(readSettings().provider) });
    await vscode.window.showInformationMessage(payload.message);
  }
}
