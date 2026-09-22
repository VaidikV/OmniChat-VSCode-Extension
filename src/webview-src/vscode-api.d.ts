/**
 * Typings for the VS Code webview API available inside webview scripts.
 * The real implementation is injected by VS Code; this file only declares
 * the shape so TypeScript can check src/webview-src/*.ts without the
 * 'vscode' npm module.
 */
interface WebviewVsCodeApi<TState = unknown> {
  postMessage(message: unknown): void;
  getState(): TState | undefined;
  setState(state: TState): void;
}

declare function acquireVsCodeApi<TState = unknown>(): WebviewVsCodeApi<TState>;
