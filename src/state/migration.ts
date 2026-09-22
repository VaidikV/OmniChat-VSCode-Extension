/**
 * One-time migration: legacy globalState 'omnichatModel' -> the
 * omnichat.ollama.model configuration key (Global target), then clear the
 * legacy key. Runs once at activate(); safe to re-run (no-op afterwards).
 */

import * as vscode from 'vscode';

const LEGACY_KEY = 'omnichatModel';

export async function runMigration(ctx: vscode.ExtensionContext): Promise<void> {
  const legacy = ctx.globalState.get<string>(LEGACY_KEY);
  if (!legacy) {
    return;
  }
  const cfg = vscode.workspace.getConfiguration('omnichat');
  const current = cfg.get<string>('ollama.model');
  if (!current) {
    await cfg.update('ollama.model', legacy, vscode.ConfigurationTarget.Global);
  }
  await ctx.globalState.update(LEGACY_KEY, undefined);
}
