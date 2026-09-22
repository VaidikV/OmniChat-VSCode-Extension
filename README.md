<div align="center">
  <img src="icon.png" width="128" alt="OmniChat AI logo" />

  # OmniChat AI

  **The simplest private AI assistant for VS Code.**

  Chat with any model without leaving your editor. Run models locally with Ollama,
  use frontier models through OpenRouter, or point it at any OpenAI-compatible
  endpoint. A guided setup wizard gets you chatting with no config files and no
  commands to memorize.

  [![Version](https://img.shields.io/visual-studio-marketplace/v/vaidikv.omnichat-ai-vscode-ext)](https://marketplace.visualstudio.com/items?itemName=vaidikv.omnichat-ai-vscode-ext)
  [![Downloads](https://img.shields.io/visual-studio-marketplace/d/vaidikv.omnichat-ai-vscode-ext)](https://marketplace.visualstudio.com/items?itemName=vaidikv.omnichat-ai-vscode-ext)
  [![Rating](https://img.shields.io/visual-studio-marketplace/r/vaidikv.omnichat-ai-vscode-ext)](https://marketplace.visualstudio.com/items?itemName=vaidikv.omnichat-ai-vscode-ext)
  [![License: MIT](https://img.shields.io/github/license/VaidikV/OmniChat-VSCode-Extension)](LICENSE.md)
  ![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.96-blue)
</div>

---

## Why OmniChat?

Most AI assistants force a tradeoff: send your code to someone else's cloud, or
spend an afternoon wiring up local models yourself.

OmniChat skips the tradeoff. Pick the provider that fits the moment and switch
mid-conversation without losing your place:

| Provider | Where your prompts go | Good for |
|----------|----------------------|----------|
| **Ollama** | Stays on your machine (your local Ollama server) | Private code, offline work, no API key |
| **OpenRouter** | OpenRouter's cloud API | Frontier models without a local GPU |
| **Custom endpoint** | The endpoint you configure | LM Studio, vLLM, llama.cpp, a company proxy |

Every provider is labeled with its privacy posture before you commit, in the
wizard, the switcher, and the status bar. Local stays local. Cloud is clearly
marked cloud. No surprises.

## Features

- **Guided setup wizard.** A 4-step flow: pick a provider, configure it,
  live-test it. Ollama is auto-detected, starter models download in one click,
  API keys are validated inline. Skippable, resumable, and re-runnable anytime
  from `OmniChat: Setup`.
- **Three providers, one switcher.** Ollama, OpenRouter, and any
  OpenAI-compatible endpoint. Local models show their sizes, OpenRouter models
  show pricing hints, and switching mid-chat keeps your transcript. The UI
  always tells you where the next message is going.
- **Ask about your code.** Select code, right-click, *Ask about selection*. The
  snippet lands in your chat draft as a quoted block. No copy-paste.
- **Insert code at cursor.** Every code block in a response gets an insert
  action. One click drops it at your cursor as a single undoable edit. When a
  response has several blocks, pick from a list.
- **Stop anytime.** A stop button cancels the in-flight request on every
  provider and keeps the partial response.
- **Keys stay secret.** API keys live only in VS Code SecretStorage. Never in
  settings files, never in logs.
- **Offline UI.** The chat panel makes zero network calls. All model traffic
  goes through the extension host, and the webview ships a strict
  Content-Security-Policy with no external scripts.

## Quickstart

1. Install **OmniChat AI** from the
   [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=vaidikv.omnichat-ai-vscode-ext).
2. The setup wizard runs on first launch (or run `OmniChat: Setup` from the
   command palette anytime).
3. Pick a provider:
   - **Ollama**: install [Ollama](https://ollama.com), then pick a starter model
     in the wizard to download it in one click. Prefer the terminal?
     `ollama pull qwen3:8b` works too.
   - **OpenRouter**: paste your API key (validated inline, stored securely).
     Pick from the Popular list or browse by vendor with pricing hints.
   - **Custom**: enter your OpenAI-compatible base URL (LM Studio, vLLM,
     llama.cpp server) and pick a preset or type your own.
4. Chat. Select code and right-click to ask about it. Click insert on any code
   block to drop it at your cursor.

## Commands

| Command | What it does |
|---------|--------------|
| `OmniChat: New chat` | Open a fresh chat panel |
| `OmniChat: Switch model or provider` | Grouped picker: local models with sizes, OpenRouter models with pricing hints, a refresh action |
| `OmniChat: Setup` | Re-run the guided setup wizard |
| `OmniChat: Ask about selection` | Send the selected code to chat (also in the editor right-click menu) |

## Configuration

Everything is set through the wizard. Every setting is also editable under
`OmniChat` in VS Code settings. Keys are never stored in settings.

| Setting | Default | What it does |
|---------|---------|--------------|
| `omnichat.provider` | `ollama` | Active provider: `ollama`, `openrouter`, or `custom` |
| `omnichat.ollama.baseUrl` | `http://127.0.0.1:11434` | Your Ollama server address |
| `omnichat.ollama.model` | | Ollama model id (pick from the switcher) |
| `omnichat.openrouter.model` | `openai/gpt-oss-20b` | OpenRouter model id |
| `omnichat.custom.baseUrl` | | Base URL of your OpenAI-compatible endpoint |
| `omnichat.custom.model` | | Default model id for the custom endpoint |
| `omnichat.custom.apiKeyRequired` | `false` | Whether the custom endpoint needs a key |
| `omnichat.requestTimeout` | `300` | Seconds without a token before a request counts as stalled |

## Privacy

OmniChat does not phone home. It sends no analytics and makes no network
requests of its own. The only network traffic is the chat request itself, and
exactly where it goes depends on the provider you chose:

- **Ollama (Private):** requests go to your Ollama server
  (`http://127.0.0.1:11434` by default). Nothing leaves your machine.
- **OpenRouter (Cloud):** requests go to OpenRouter's API. Your prompts leave
  your machine and are governed by OpenRouter's privacy policy.
- **Custom endpoint:** requests go wherever you point them. Verify the endpoint
  yourself before sending sensitive code.

The status bar always shows your provider, model, and a Private / Cloud /
Custom tag, so the current posture is visible at a glance.

## How it works

- The chat UI is a VS Code webview with a strict Content-Security-Policy
  (`connect-src 'none'`): it cannot reach the network at all.
- All LLM traffic is plain `fetch` from the extension host, streamed token by
  token and cancellable via `AbortController`.
- Markdown is rendered with a bundled copy of `marked` and sanitized with a
  bundled copy of DOMPurify. No CDNs, no external scripts.
- Secrets use VS Code SecretStorage. Diagnostics go to the OmniChat output
  channel.

## Roadmap

v0.1.0 is deliberately scoped: chat, provider choice, and the editor slice.
No agent mode, no autonomous file edits. Planned next: richer context controls,
prompt templates, and more provider conveniences. Ideas and PRs are welcome.

## Contributing

Issues and pull requests are welcome. To build locally:

```bash
npm install
npm run compile   # builds the webview bundle and TypeScript
npm test          # lint + unit tests
```

## License

MIT. See [LICENSE.md](LICENSE.md).
