/**
 * OutputChannel logger for OmniChat. Replaces console.log in shipped code.
 *
 * Usage: call initLog(context) once from activate(), then info/warn/error/
 * anywhere. Before initLog (or in unit tests) the functions are silent no-ops.
 *
 * Never log secrets or full message contents: keep values out of this logger.
 */

import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;
let debugEnabled = false;

/** Create the "OmniChat" output channel; call once from activate(). */
export function initLog(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('OmniChat');
  context.subscriptions.push(channel);
}

/** Enable verbose debug() output. Off by default. */
export function setDebugEnabled(enabled: boolean): void {
  debugEnabled = enabled;
}

function write(level: string, message: string): void {
  channel?.appendLine(`[${new Date().toISOString()}] [${level}] ${message}`);
}

export function info(message: string): void {
  write('info', message);
}

export function warn(message: string): void {
  write('warn', message);
}

export function error(message: string): void {
  write('error', message);
}

export function debug(message: string): void {
  if (debugEnabled) {
    write('debug', message);
  }
}
