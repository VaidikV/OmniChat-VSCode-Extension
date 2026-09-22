/**
 * Unit tests for the wizard state machine (src/state/wizardState.ts):
 * persistence round-trips, monotonic step marking, resume semantics, and
 * the pure entry-step resolution used by runSetupWizard.
 * Run under plain node:test (no vscode, no Electron).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  markWizardStep,
  readWizardState,
  resolveInitialStep,
  writeWizardState,
  type WizardPersistedState,
} from './wizardState.js';

type Ctx = Parameters<typeof readWizardState>[0];

/** In-memory stand-in for vscode.ExtensionContext.globalState. */
function fakeCtx(initial?: WizardPersistedState): Ctx {
  let stored: WizardPersistedState | undefined = initial;
  return {
    globalState: {
      get: (_key: string) => stored,
      update: async (_key: string, value: WizardPersistedState) => {
        stored = value;
      },
    },
  } as unknown as Ctx;
}

describe('readWizardState', () => {
  it('returns not-started when nothing is stored', () => {
    assert.deepEqual(readWizardState(fakeCtx()), { status: 'not-started', furthestStep: 0 });
  });

  it('clamps furthestStep into 0..3', () => {
    assert.equal(
      readWizardState(fakeCtx({ status: 'in-progress', furthestStep: 99 })).furthestStep,
      3,
    );
    assert.equal(
      readWizardState(fakeCtx({ status: 'in-progress', furthestStep: -2 })).furthestStep,
      0,
    );
  });

  it('floors fractional steps', () => {
    assert.equal(
      readWizardState(fakeCtx({ status: 'in-progress', furthestStep: 1.9 })).furthestStep,
      1,
    );
  });

  it('treats an unknown status as not-started', () => {
    const state = readWizardState(
      fakeCtx({ status: 'weird' as never, furthestStep: 2 }),
    );
    assert.equal(state.status, 'not-started');
  });

  it('preserves the provider choice', () => {
    const state = readWizardState(
      fakeCtx({ status: 'in-progress', furthestStep: 2, provider: 'openrouter' }),
    );
    assert.equal(state.provider, 'openrouter');
  });
});

describe('writeWizardState', () => {
  it('round-trips the persisted state', async () => {
    const ctx = fakeCtx();
    await writeWizardState(ctx, { status: 'in-progress', furthestStep: 2, provider: 'custom' });
    assert.deepEqual(readWizardState(ctx), {
      status: 'in-progress',
      furthestStep: 2,
      provider: 'custom',
    });
  });
});

describe('markWizardStep', () => {
  it('marks in-progress and advances furthestStep', async () => {
    const ctx = fakeCtx();
    await markWizardStep(ctx, 1, 'ollama');
    assert.deepEqual(readWizardState(ctx), {
      status: 'in-progress',
      furthestStep: 1,
      provider: 'ollama',
    });
  });

  it('advances furthestStep monotonically, never backwards', async () => {
    const ctx = fakeCtx();
    await markWizardStep(ctx, 2, 'ollama');
    await markWizardStep(ctx, 1, 'ollama');
    assert.equal(readWizardState(ctx).furthestStep, 2);
  });

  it('keeps the earlier provider when a later mark omits it', async () => {
    const ctx = fakeCtx();
    await markWizardStep(ctx, 1, 'openrouter');
    await markWizardStep(ctx, 2);
    assert.equal(readWizardState(ctx).provider, 'openrouter');
  });
});

describe('resolveInitialStep', () => {
  it('starts a never-started wizard at step 0 (welcome)', () => {
    assert.equal(
      resolveInitialStep({ status: 'not-started', furthestStep: 0 }),
      0,
    );
  });

  it('resumes an interrupted wizard at the furthest completed step', () => {
    assert.equal(
      resolveInitialStep({ status: 'in-progress', furthestStep: 2, provider: 'ollama' }),
      2,
    );
  });

  it('restarts a completed wizard at step 1 (provider choice)', () => {
    assert.equal(
      resolveInitialStep({ status: 'ready', furthestStep: 3, provider: 'ollama' }),
      1,
    );
  });

  it('jumps to step 2 when a startProvider override is given', () => {
    assert.equal(
      resolveInitialStep({ status: 'not-started', furthestStep: 0 }, { startProvider: 'openrouter' }),
      2,
    );
    assert.equal(
      resolveInitialStep(
        { status: 'in-progress', furthestStep: 1, provider: 'ollama' },
        { startProvider: 'custom' },
      ),
      2,
    );
  });
});
