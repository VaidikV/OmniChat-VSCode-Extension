# OmniChat AI 🧠💻

A privacy-first VS Code extension to chat with any local LLM through Ollama—including the new OpenAI open-weight models (gpt-oss-120b and gpt-oss-20b).
Get code help, brainstorm, and run advanced AI—all offline. Your code and queries never leave your machine.

![demo1](ss1.jpg)
![demo2](ss2.jpg)

- **Works with Any Major Open LLM**: Use DeepSeek, Gemma, Llama 3, or the newest OpenAI models (gpt-oss-120b, gpt-oss-20b) through Ollama.
- **Real-Time AI Interaction**: Get coding assistance, brainstorm ideas, and debug issues without leaving VS Code
- **Privacy-First**: All processing happens locally - your code and data never leave your machine
- **Beautifully Formatted Responses**: Clean markdown rendering for better readability
- **Seamless Integration**: Matches VS Code's themes for a consistent experience

## Installation

### Prerequisites
- [Visual Studio Code](https://code.visualstudio.com/)
- [Ollama](https://ollama.ai/) installed and running locally

### Quick Install
1. Install from VS Code Marketplace:
   - Open VS Code
   - Go to Extensions (Ctrl+Shift+X)
   - Search for "OmniChat AI"
   - Click Install

2. Pull your preferred LLM with Ollama:
   ```bash
   ollama pull gpt-oss-120b
   ollama pull gpt-oss-20b
   # Or any other model you prefer
   ollama pull deepseek-r1:1.5b
   ollama pull gemma:7b
   ollama pull llama3:8b
   ```

## Usage

1. Start Ollama in your terminal:
   ```bash
   ollama serve
   ```

2. In VS Code:
   - Open Command Palette (Ctrl+Shift+P)
   - Run `OmniChat: Start`
   - A chat panel will open

3. Set your preferred model:
   - Open Command Palette (Ctrl+Shift+P)
   - Run `OmniChat: Set Model`
   - Enter your model (e.g. gpt-oss-120b, gpt-oss-20b, deepseek-r1:1.5b, etc.)

4. Start chatting!
   - Type your question and click "Ask"
   - Receive beautifully formatted responses

## Models

OmniChat AI works with any model available through Ollama. Some popular options:

- `gpt-oss-120b` — Large, enterprise-grade open-weight model
- `gpt-oss-20b` — Great for laptops and edge computers
- `deepseek-r1:1.5b` - Fast, lightweight coding assistant
- `deepseek-r1:8b` - Good balance of speed and capability
- `deepseek-r1:32b` - Most capable DeepSeek model
- `gemma:7b` - Google's lightweight model
- `llama3:8b` - Meta's efficient model

> **Tip:** All you need is a single command (e.g. `ollama pull gpt-oss-120b`) and you’re ready to go.

## Credits

This project was inspired by [Fireship's video](https://www.youtube.com/@Fireship) on building VS Code extensions.

Special thanks to [Ollama](https://ollama.ai/) for enabling local AI capabilities.

## License

This project is licensed under the MIT License.