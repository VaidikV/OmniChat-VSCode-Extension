# Changelog

All notable changes to the **OmniChat AI** (formerly DeepSeek Ext) extension will be documented in this file.

This project uses [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- **Context-aware Code Suggestions:** The extension will soon be able to intelligently read your open files and code context in VS Code, enabling it to proactively suggest code completions, refactorings, and explanations—without the user needing to manually paste code snippets into the chat.
- Support for more custom prompt templates, fine-tuning UI, and GPT-OSS agent modes.

---

## [0.1.0] – 2026-09-22

### Added
- **First-run setup wizard:** a guided 4-step QuickPick flow (pick a provider, configure it, live-test it) with Ollama detection, one-click starter model downloads with progress and cancel, OpenRouter key entry with inline validation, and custom endpoint presets. Skippable, resumable, and re-runnable from the welcome view, the status bar, or "OmniChat: Setup".
- **Provider support:** Ollama (local), OpenRouter (cloud, API key in SecretStorage), and any OpenAI-compatible endpoint (LM Studio, vLLM, llama.cpp server) behind one provider switcher.
- **Grouped model switcher:** "OmniChat: Switch model or provider" lists installed Ollama models with sizes, OpenRouter models with a pinned Popular group, vendor groups, pricing hints and a Cloud tag, plus a refresh action. Mid-chat switches preserve the transcript and disclose where the next message goes.
- **Welcome view and status bar:** the OmniChat activity bar view walks through setup, then shows the active model, try-it prompts, and the per-provider privacy line; the status bar shows provider, model, and a Private/Cloud/Custom tag.
- **Editor slice:** "OmniChat: Ask about selection" sends the selected code into the chat input as a quoted block (editor context menu, 8,000-character truncation); "Insert code at cursor" inserts the latest response's code at the editor cursor as a single undoable edit.
- **Actionable errors:** every failure (Ollama unreachable, model not installed, bad API key, billing, rate limits, timeouts) shows a plain-language message with fix buttons instead of raw errors.

### Fixed
- **Trust fixes:** the markdown renderer (marked) and sanitizer (DOMPurify) are bundled, the webview ships a strict Content-Security-Policy with `connect-src 'none'` and makes zero network calls, and all LLM traffic goes through the extension host.
- Removed all `console.log` calls from shipped code; diagnostics go to the "OmniChat" output channel.
- **Setup wizard completion:** the "Everything works." screen now states the selected provider, the selected model, and the per-provider privacy label (Private/Cloud/Custom) before finishing.
- **Recovery actions:** the "Ollama is not reachable" error now offers "Use OpenRouter instead" and "Edit host" alongside the existing actions.
- **Custom endpoint errors:** an unreachable custom endpoint now shows the exact URL that was attempted.
- **Settings:** all `omnichat.*` settings now carry human-readable titles in the Settings UI.
- **Tests:** added mocked-HTTP tests for all three providers and the provider factory, wizard state-machine tests, a no-CDN static assertion that runs in the regular test command, and coverage measurement (`npm run test:coverage`); the ee2 sanitization/CSP/privacy suite is now wired into `npm test`.

### Changed
- API keys live only in VS Code SecretStorage, never in settings or logs.
- Stop-generation now aborts the in-flight request uniformly across providers via AbortController, keeping the partial response.
- Privacy claims are per-provider: local providers are labeled Private, OpenRouter is labeled Cloud, custom endpoints carry a verify-it-yourself note.

---

## [0.0.2] – 2025-08-05

### Added
- **Support for OpenAI’s Open-Weight Models:** Now works with `gpt-oss-120b` and `gpt-oss-20b`—downloadable and fully local models from OpenAI, no API key required!
- Updated documentation and marketplace messaging to highlight support for OpenAI’s new models alongside DeepSeek, Gemma, Llama, etc.
- Sample usage/instructions to show how to pull and chat with the new models in VS Code.
- Minor improvements to UI, auto-scrolling, and result formatting for larger/longer LLM outputs.

### Changed
- Project renamed from “DeepSeek Ext” to **OmniChat AI** to reflect support for _any_ local LLM, not just DeepSeek.
- Improved markdown and code rendering in chat window.
- Enhanced privacy and local-only messaging for user clarity.

---

## [0.0.1] – 2025-01-xx

### Added
- **Initial release:** DeepSeek VS Code assistant supporting local queries via Ollama.
- Syntax-highlighted answers and instant markdown rendering.
- Local, privacy-first workflow with no Internet dependency.

---

