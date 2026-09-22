/**
 * Welcome WebviewView (technical design section 12).
 *
 * Shares the chat panel's CSP/nonce HTML builder (src/ui/html.ts). Empty
 * state: numbered setup steps with [Set up OmniChat]. Ready state:
 * "You're chatting with {model} on {provider}." with [Change] [New chat],
 * three try-it prompts, and the per-provider privacy line.
 */

import * as vscode from 'vscode';
import { readSettings } from '../state/settings.js';
import { createNonce } from '../util/nonce.js';
import type { ExtensionDeps } from './deps.js';
import { buildWelcomeHtml } from './html.js';
import {
  activeModel,
  isSetupComplete,
  privacyLabelFor,
  providerDisplayName,
} from './settingsUtil.js';

let currentView: vscode.WebviewView | undefined;

interface WelcomeState {
  setupComplete: boolean;
  providerDisplayName?: string;
  modelId?: string;
  privacyLabel?: string;
}

async function buildState(deps: ExtensionDeps): Promise<WelcomeState> {
  const settings = readSettings();
  const setupComplete = await isSetupComplete(deps.ctx);
  if (!setupComplete) {
    return { setupComplete };
  }
  return {
    setupComplete,
    providerDisplayName: providerDisplayName(settings.provider),
    modelId: activeModel(settings),
    privacyLabel: privacyLabelFor(settings),
  };
}

async function postInit(deps: ExtensionDeps): Promise<void> {
  if (currentView) {
    await currentView.webview.postMessage({
      command: 'init',
      state: await buildState(deps),
    });
  }
}

/** Re-push init state (call on config change / wizard completion). */
export function refreshWelcomeView(deps: ExtensionDeps): void {
  void postInit(deps);
}

export function registerWelcomeView(deps: ExtensionDeps): vscode.Disposable {
  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(webviewView: vscode.WebviewView): void {
      currentView = webviewView;
      const { ctx } = deps;
      webviewView.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media', 'webview')],
      };
      webviewView.webview.html = buildWelcomeHtml({
        nonce: createNonce(),
        cspSource: webviewView.webview.cspSource,
        scriptUri: webviewView.webview
          .asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', 'webview', 'welcome.js'))
          .toString(),
        styleUri: webviewView.webview
          .asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', 'webview', 'bundle.css'))
          .toString(),
      });
      webviewView.onDidDispose(() => {
        if (currentView === webviewView) {
          currentView = undefined;
        }
      });
      webviewView.webview.onDidReceiveMessage((msg: { command?: string; text?: string }) => {
        switch (msg.command) {
          case 'ready':
            void postInit(deps);
            return;
          case 'openSetup':
            void deps.runSetupWizard();
            return;
          case 'switchModel':
            void deps.openModelPicker();
            return;
          case 'openChat':
            deps.revealChat();
            return;
          case 'usePrompt':
            if (msg.text) {
              deps.insertPromptToChat(msg.text);
            }
            return;
          default:
            break;
        }
      });
    },
  };
  return vscode.window.registerWebviewViewProvider('omnichat.welcome', provider);
}
