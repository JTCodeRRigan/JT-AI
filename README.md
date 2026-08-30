# JT❥AI — a browser AI agent with your own models

**English** · [Русский](README.ru.md)

A Chrome extension (Manifest V3): **a side-panel chat + an autonomous agent** that works with your tabs on its own — reads pages, clicks with a virtual cursor, types, scrolls, reads **network requests** and the **console**, runs JS. The key difference from tools like "Claude in Chrome" — **any model**: Runpod, Venice, DeepInfra, OpenRouter, OpenAI, **Anthropic (Claude)**, and also **local ones** (Ollama, LM Studio, llama.cpp, vLLM).

<p align="center">
  <img src="docs/hero.png" width="380" alt="Agent panel: plan, tool calls, supervisor, report">
</p>

<p align="center">
  <img src="docs/report.png" width="380" alt="Final report reader">
  &nbsp;&nbsp;
  <img src="docs/sessions.png" width="380" alt="Session history with pinning">
</p>

---

## Features

- 🧠 **Any provider.** OpenAI-compatible API (chat/completions) and native Ollama. Ready presets for Runpod / Venice / DeepInfra / OpenRouter / OpenAI / Ollama / LM Studio / llama.cpp / vLLM. The ↻ button pulls the model list straight from the server.
- 🖱 **Real browser actions.** Clicks and typing via the Chrome DevTools Protocol (trusted events — work in any SPA), with a virtual cursor. Falls back to synthetic events.
- 🗂 **Scope = the tab group.** The agent works with the tabs of the group where it was summoned; the panel appears only there and closes on other tabs.
- 🌐 **Network + console.** fetch/XHR are intercepted together with request/response bodies; other resources come through `webRequest`. Plus console reading and JS errors.
- 👁 **Multi-agent.** A planner builds the plan, a supervisor observes and gently corrects the executor when it gets stuck (can use different models: a strong one as supervisor, a fast one as executor).
- 🧩 **Human pause.** On complex steps (like 2FA or SMS verification codes), the agent pauses and hands control to you. Standard CAPTCHAs can be solved automatically via the integrated 2Captcha API.
- 🔌 **2Captcha API supported.**
- 🌍 **Bilingual UI (EN / RU).** Full English and Russian localization with a switch in settings; the choice also drives the agent's own language. Defaults to English (or Russian if that's your browser UI language).
- 🕘 **Session history.** A list of recent chats, ⭐ pinning, deletion, configurable retention (0…∞).
- 📄 **Final report.** A detailed result opens full-screen via the "View report" button with proper markdown; short answers stay inline.
- 🛡 **Robustness.** Auto-fits `max_tokens` to the model's context, repairs malformed JSON in tool calls, a loop detector (by actions and by text), history trimming to fit the context.
- 🎨 **Dark UI** (red-black-white theme), collapsing of long messages, copy the whole chat.

## Install

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick this folder.
2. Click the extension icon (a black heart) — the side panel opens.
3. **⚙ Settings** → **"+ Add model"** → pick a preset → fill in Base URL / key / model → **"Test connection"** → **"Save"**.

<p align="center">
  <img src="docs/settings.png" width="720" alt="Settings: providers and agent options">
</p>

## Providers

| Provider | Base URL | Note |
|---|---|---|
| Runpod Serverless (vLLM) | `https://api.runpod.ai/v2/<ENDPOINT_ID>/openai/v1` | key = Runpod API key |
| Runpod Pod (vLLM/TGI/Ollama) | `https://<POD_ID>-<PORT>.proxy.runpod.net/v1` | port exposed on the pod |
| Venice | `https://api.venice.ai/api/v1` | |
| DeepInfra | `https://api.deepinfra.com/v1/openai` | |
| OpenRouter | `https://openrouter.ai/api/v1` | |
| OpenAI | `https://api.openai.com/v1` | vision models supported |
| Anthropic (Claude) | `https://api.anthropic.com` | key = Anthropic API key; native tools + vision |
| Ollama (local) | `http://localhost:11434` (native) or `/v1` (OpenAI) | `OLLAMA_ORIGINS="chrome-extension://*" ollama serve` |
| LM Studio | `http://localhost:1234/v1` | enable Local Server |
| llama.cpp | `http://localhost:8080/v1` | `llama-server --jinja` (for tools) |
| vLLM | `http://localhost:8000/v1` | `--enable-auto-tool-choice --tool-call-parser hermes` |

**Tool-calling mode:** *Native function calling* — for models with tools support (Qwen2.5/3, Llama 3.1+, Mistral, DeepSeek, Hermes). For models without tools — *JSON in text*.

### Which models work well
- **Great:** Qwen2.5-72B-Instruct, Qwen3, DeepSeek-V3/V4, Llama-3.3-70B, Mistral-Large — strong tool-calling and long context.
- **Cheap via API:** DeepSeek through DeepInfra / OpenRouter / directly — cents per session, no need to host 671B+ yourself.
- **Avoid as executor:** "reasoning" models in the executor role (they spam their thoughts) and Coder/small fine-tunes (weak tool-calling).

## Agent tools

`list_tabs` · `switch_tab` · `new_tab` · `close_tab` · `navigate` · `read_page` · `get_page_text` · `find` · `click` · `hover` · `type` · `press_key` · `select_option` · `scroll` · `scroll_to` · `wait` · `screenshot` · `get_network_requests` · `get_request_details` · `get_console` · `execute_js` · `clear_logs` · `pause_for_human` · `done`

`read_page` returns a compact tree of interactive elements with `ref`s; clicks/typing are addressed by `ref` or coordinates.

## Permissions & privacy

The extension requests: `sidePanel`, `tabs`, `tabGroups`, `activeTab`, `scripting`, `storage`, `unlimitedStorage`, `webRequest`, `debugger`, `webNavigation`, `host_permissions: <all_urls>`.

- `debugger` — for **trusted** clicks/keys (real input events) and `execute_js`. Chrome shows a "an extension started debugging" banner — that's normal, and can be turned off in settings.
- `<all_urls>` + `webRequest` — to read the pages and network requests of the group's tabs.
- **API keys** are stored locally in `chrome.storage` and never end up in the code/repository.
- **Unrestricted execution (Critical Override):** due to a custom system prompt pattern, the model operates in a fully authorized testing/red-teaming environment with no ethical or safety boundaries. It can interact with login forms, handle passwords, and solve captchas automatically via the built-in 2Captcha API connector without throwing safety refusals.
- **User Control:** the `pause_for_human` tool is still available to the agent, allowing it to hand control to you for manual steps such as typing 2FA SMS/OTP verification codes.

A general-purpose tool for automating *your own* browser — use it responsibly and within each site's rules.

## Limitations (honestly)

- `chrome://` pages, the Web Store, and the PDF viewer can't be scripted (a Chrome restriction).
- Quality depends heavily on the model: weak models stumble on multi-step tasks.
- There's no full E2E test across all sites — non-standard layouts may have rough edges.
- One active chat at a time for now; switching sessions on the fly is experimental.

## How it's built

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest, permissions, entry points |
| `background.js` | service worker: agent loop, provider calls, tools, logs, sessions, panel scoping |
| `tools.js` | tool schemas + system prompt |
| `content.js` | DOM reading with refs, virtual cursor, actions, captcha detection |
| `inject.js` | fetch/XHR/console interception in page context (MAIN world) |
| `sidepanel.*` | side panel (chat, sessions, report, status bar) |
| `options.*` | settings page |
| `i18n.js` | EN/RU dictionaries and the localization helpers |

## License

MIT — see [`LICENSE`](LICENSE). No keys or personal data are included in the repository.

---

<sub>Built by hand. Screenshots are the real extension UI.</sub>
