/**
 * Provider abstraction types for OmniChat.
 *
 * Pure module: MUST NOT import 'vscode'. Everything here is unit-testable
 * under plain node.
 */

export type ProviderId = 'ollama' | 'openrouter' | 'custom';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelInfo {
  /** Provider-native model id, e.g. 'llama3.1:8b' or 'openai/gpt-oss-20b'. */
  id: string;
  /** Human label for pickers. */
  label: string;
  /** Size, context window, pricing hint, ... */
  description?: string;
  contextLength?: number;
}

export type StreamEvent =
  | { type: 'token'; text: string }
  | { type: 'reasoning'; text: string } // reasoning models; webview renders collapsed
  | { type: 'done'; promptTokens?: number; completionTokens?: number };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** Stop-generation wired end to end. */
  signal: AbortSignal;
  /**
   * Milliseconds without any token before the stream is treated as stalled.
   * The stream layer throws OmniChatError('TIMEOUT', providerId) when it fires.
   * When undefined, providers fall back to the DEFAULT_STALL_TIMEOUT_MS.
   */
  stallTimeoutMs?: number;
}

export interface PullProgress {
  completed: number;
  total: number;
  status: string;
}

export interface LLMProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  /** Drives the privacy label in the UI. */
  readonly isLocal: boolean;
  /** Throws OmniChatError on failure. */
  checkConnection(): Promise<void>;
  listModels(): Promise<ModelInfo[]>;
  chatStream(req: ChatRequest): AsyncGenerator<StreamEvent>;
  pullModel?(model: string, onProgress: (p: PullProgress) => void, signal: AbortSignal): Promise<void>;
}

/**
 * Stall timeout applied when ChatRequest.stallTimeoutMs is not set.
 * Decision #26: 300 seconds, measured as time without any token received.
 */
export const DEFAULT_STALL_TIMEOUT_MS = 300_000;
