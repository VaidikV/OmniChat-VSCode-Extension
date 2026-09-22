/**
 * Shared dependency surface for the UI layer (EE-3).
 *
 * Every UI module (wizard, model picker, error presenter, chat panel, status
 * bar, welcome view) receives this instead of importing its siblings, which
 * keeps the module graph acyclic. extension.ts wires the concrete functions.
 */

import type * as vscode from 'vscode';
import type { ProviderId } from '../providers/types.js';

export interface WizardOptions {
  /** Jump straight into a provider path (used by "Use X instead" actions). */
  startProvider?: ProviderId;
}

export interface ModelPickerOptions {
  initialProvider?: ProviderId;
}

export interface ExtensionDeps {
  ctx: vscode.ExtensionContext;
  runSetupWizard: (opts?: WizardOptions) => Promise<void>;
  openModelPicker: (opts?: ModelPickerOptions) => Promise<void>;
  /** Reveal (creating if needed) the chat panel. */
  revealChat: () => void;
  /** Reveal the chat panel and set the composer text. */
  insertPromptToChat: (text: string) => void;
  /** Reveal the chat panel and append a context block to the composer draft. */
  appendChatContext: (text: string) => void;
  /** Refresh the status bar, welcome view, and open chat panels. */
  refreshSurfaces: () => void;
  /** Active editor, falling back to the last active editor (FR-17 build note). */
  resolveTargetEditor: () => vscode.TextEditor | undefined;
}
