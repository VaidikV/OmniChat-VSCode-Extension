/**
 * Status bar item (FR-14, decision #20).
 *
 * Ready: "$(comment-discussion) {provider} · {model}" with a privacy tag in
 * the tooltip; clicking opens the model switcher. Setup-incomplete:
 * "OmniChat: set up", clicking reopens the wizard.
 */

import * as vscode from 'vscode';
import { readSettings } from '../state/settings.js';
import type { ExtensionDeps } from './deps.js';
import { activeModel, isSetupComplete, privacyTag, providerDisplayName } from './settingsUtil.js';

export interface OmniChatStatusBar extends vscode.Disposable {
  refresh(): Promise<void>;
}

export function createStatusBar(deps: ExtensionDeps): OmniChatStatusBar {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

  const refresh = async (): Promise<void> => {
    const settings = readSettings();
    if (!(await isSetupComplete(deps.ctx))) {
      item.text = 'OmniChat: set up';
      item.tooltip = 'OmniChat is not set up yet. Click to run the two-minute setup.';
      item.command = 'omnichat.setup';
    } else {
      const display = providerDisplayName(settings.provider);
      const model = activeModel(settings);
      const tag = privacyTag(settings);
      item.text = `$(comment-discussion) ${display} · ${model}`;
      item.tooltip = `OmniChat: ${model} on ${display} (${tag}). Click to switch model or provider.`;
      item.command = 'omnichat.switchModel';
    }
    item.show();
  };

  void refresh();
  return { refresh, dispose: () => item.dispose() };
}
