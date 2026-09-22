/**
 * Setup wizard state machine persistence (decision #30).
 *
 * The wizard never auto-opens (decision #20); when it does run, its progress
 * is persisted so an interrupted wizard resumes at the furthest completed
 * step, a never-started wizard begins at step 1, and cancelling leaves prior
 * configuration untouched.
 *
 * Steps: 0 = welcome, 1 = provider choice, 2 = provider path, 3 = test.
 */

import * as vscode from 'vscode';
import type { ProviderId } from '../providers/types.js';

const WIZARD_STATE_KEY = 'omnichat.wizard.state';

export type WizardStatus = 'not-started' | 'in-progress' | 'ready';

export interface WizardPersistedState {
  status: WizardStatus;
  /** Highest fully completed step index (0-3). */
  furthestStep: number;
  provider?: ProviderId;
}

const INITIAL: WizardPersistedState = { status: 'not-started', furthestStep: 0 };

export function readWizardState(ctx: vscode.ExtensionContext): WizardPersistedState {
  const raw = ctx.globalState.get<WizardPersistedState>(WIZARD_STATE_KEY);
  if (!raw || typeof raw.furthestStep !== 'number') {
    return { ...INITIAL };
  }
  const status: WizardStatus =
    raw.status === 'in-progress' || raw.status === 'ready' ? raw.status : 'not-started';
  return {
    status,
    furthestStep: Math.min(3, Math.max(0, Math.floor(raw.furthestStep))),
    provider: raw.provider,
  };
}

export async function writeWizardState(
  ctx: vscode.ExtensionContext,
  state: WizardPersistedState,
): Promise<void> {
  await ctx.globalState.update(WIZARD_STATE_KEY, state);
}

/** Record that a step completed; advances furthestStep monotonically. */
export async function markWizardStep(
  ctx: vscode.ExtensionContext,
  step: number,
  provider?: ProviderId,
): Promise<void> {
  const current = readWizardState(ctx);
  await writeWizardState(ctx, {
    status: 'in-progress',
    furthestStep: Math.max(current.furthestStep, step),
    provider: provider ?? current.provider,
  });
}
