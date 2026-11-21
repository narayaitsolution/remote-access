# Remote Terminal

[![Latest release](https://img.shields.io/github/v/release/narayaitsolution/remote-access)](https://github.com/narayaitsolution/remote-access/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A portable SSH terminal for Windows with split screens, an SFTP file sidebar, a VS Code-like editor and a built-in AI assistant.

**[⬇ Download `RemoteTerminal.exe`](https://github.com/narayaitsolution/remote-access/releases/latest)**: one file, no installer (Windows 10/11).

## Features

- **Split screen & tabs**: split any pane vertically or horizontally, as often as you like, and move between panes with `Alt+Arrow`.
- **SFTP sidebar, on by default**: browse, upload, download and edit server files. It follows the terminal's current folder, even inside tmux. Drag & drop from Explorer works.
- **tmux support**: connect straight into a named tmux session. After a network drop the app reconnects to the same session. The mouse wheel scrolls tmux history.
- **Copy that just works**: select to copy, right-click to paste, in a plain shell, in tmux and in programs like opencode or htop.
- **Code editor**: Monaco (the editor of VS Code) with highlighting for 70+ languages, autocomplete and `Ctrl+S` to save to the server. Also includes PDF, Markdown and image viewers, and Office files open in Word/Excel/PowerPoint with automatic upload.
- **Secure logins**: password or SSH key, encrypted with Windows DPAPI, with `known_hosts` checking.
- **Portable**: settings and servers live in `config.toml` next to the `.exe`. The UI is in English or Indonesian.

## AI assistant

Open the **AI Sidebar** with `Ctrl+Shift+A`. By default it is a normal chat. When a request needs the server, it can read the screen, run commands, and read and write files, **each time with your permission**.

| Provider | What you need |
|---|---|
| **Claude Code** (Anthropic) | The `claude` CLI, signed in. No API key needed. |
| **Codex** (OpenAI) | The `codex` CLI, signed in. No API key needed. |
| **Google Antigravity** (Gemini, plus the other models your account offers) | The [Antigravity](https://antigravity.google) CLI (`agy`), signed in with your Google account. No API key needed. |
| **Any OpenAI-compatible API** | OpenAI, OpenRouter, Groq, DeepSeek, Ollama, LM Studio, … (keys are stored encrypted) |

- **Agent mode**: the AI does a task on screen from start to finish. It finds the file, edits it, tests the result, fixes errors and reports what changed. Risky actions (deleting data, restarting services, firewall changes…) always ask you first.
- **AI Companion**: Copilot-style code suggestions in the editor, requested only with `Alt+\` to save tokens.
- The tools act on the server, not on your PC. Claude Code gets no local tools, Codex runs read-only, and Antigravity's local tools are refused.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+T` | New tab |
| `Ctrl+Shift+W` / `Ctrl+Shift+E` | Split vertically / horizontally |
| `Ctrl+Shift+Q` | Close split / tab (asks before closing a tab) |
| `Ctrl+Shift+B` | SFTP sidebar (left) |
| `Ctrl+Shift+A` | AI Sidebar (right) |
| `Alt+Arrow` | Move between panes |
| `Ctrl+Tab`, `Ctrl+1…9` | Switch tabs |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copy / paste |
| `Ctrl+Wheel`, `F11` | Zoom / full screen |

Every shortcut can be changed in `config.toml`.

## Updates

The app checks GitHub for a new version at start-up. To update, close the app and replace `RemoteTerminal.exe`. **Keep `config.toml` and `known_hosts`**: they hold your servers and settings.

## Development

Requirements: Windows 10/11, [Go](https://go.dev/dl/) 1.26+, [Node.js](https://nodejs.org/) 20+.

```powershell
go install github.com/wailsapp/wails/v2/cmd/wails@v2.17.1   # once
.\build.ps1        # → build\bin\RemoteTerminal.exe
go test ./...      # tests (in-process fake SSH/SFTP server)
```

Releases: bump `version.go` and `wails.json`, add a row below and a section to [`CHANGELOG.id.md`](CHANGELOG.id.md), then push a `v<version>` tag. GitHub Actions publishes the `.exe`. A new feature raises the major number; fixes raise the minor.

## Version history

The full Indonesian changelog is in [`CHANGELOG.id.md`](CHANGELOG.id.md) and in the app (ⓘ).

<details>
<summary><b>Show all versions</b></summary>

| Version | Type | Changes |
|---|---|---|
| **12.0** | Feature | **Google Antigravity** in the AI Sidebar: Gemini and the other models of your Google account through the local `agy` CLI, without an API key. New shortcuts: split `Ctrl+Shift+W` / `Ctrl+Shift+E`, close `Ctrl+Shift+Q` (asks before closing a tab); existing default shortcuts move automatically. Fixed stray mouse codes (`35;96;40M…`) appearing when moving the mouse in opencode or the shell. The donor list is always read from GitHub. Shorter README. |
| **11.1** | Minor | UI in Indonesian and English (follows Windows by default, selectable in ⓘ, new `language` setting); English version history and update notes. Information window tabs: Features · Version history · **♥ Donate** (donation link and donor list from `donors.json`). New icon: the prompt `>` ends in a Wi-Fi signal. |
| **11.0** | Feature | Select-to-copy in a plain shell. Clicks pass through to mouse-aware programs. Per-file transfer progress. Information window (ⓘ). Start-up update check with *Update* / *Skip*. Executable is always `RemoteTerminal.exe`. *Auto-allow* checkboxes replaced by agent mode. |
| **10.0** | Feature | AI Sidebar **agent mode**. **AI Companion** inline suggestions (`Alt+\`). |
| **9.0** | Feature | VS Code-like editing: autocomplete, snippets, language picker, format, command palette, word wrap, sticky scroll. |
| **8.4** | Minor | Releases built by GitHub Actions; CI on every push. |
| **8.3** | Minor | New app icon. |
| **8.2** | Minor | Windows Explorer file icons in the sidebar. |
| **8.1** | Minor | Fixed a grey box covering the first tab title. |
| **8.0** | Feature | PDF/Markdown/image viewers. Office editing with auto-upload. First-run winget setup. |
| **7.0** | Feature | OpenAI-compatible AI providers. |
| **6.0** | Feature | Built-in Monaco editor with conflict detection. |
| **5.1** | Minor | AI no longer types into the screen unless asked; background command tool. |
| **5.0** | Feature | AI chat by default with read/change permissions; AI can drive on-screen programs. |
| **4.0** | Feature | AI assistant via Claude Code / Codex. |
| **3.1** | Minor | SSH key documentation. |
| **3.0** | Feature | SSH key login. |
| **2.1** | Minor | Wrapped lines rejoined on copy. |
| **2.0** | Feature | Notifications for copy and file actions. |
| **1.2** | Minor | CRLF multi-line copy; MIT license. |
| **1.1** | Minor | Detailed README. |
| **1.0** | Feature | First release. |
</details>

## Support

Remote Terminal is free and open source (MIT). The app accepts voluntary donations (ⓘ → ♥ Donate). Stars, bug reports and pull requests are welcome too.

## License

[MIT](LICENSE) © 2026 narayaitsolution.
