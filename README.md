# Remote Terminal

[![Latest release](https://img.shields.io/github/v/release/narayaitsolution/remote-access)](https://github.com/narayaitsolution/remote-access/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A portable SSH terminal for Windows with an SFTP sidebar, a VS Code-like editor and a built-in AI assistant. It has reliable copy-paste and connects straight into `tmux` sessions.

**[⬇ Download `RemoteTerminal.exe`](https://github.com/narayaitsolution/remote-access/releases/latest)**: a single file with no installer (Windows 10/11, requires WebView2, which is preinstalled).

## Highlights

- **Portable**: one `.exe`. Settings live in `config.toml` next to it, or in `%APPDATA%\RemoteTerminal` if that folder is not writable.
- **Survives bad networks**: keepalives, auto-reconnect and re-attach to the exact tmux session you were in.
- **Copy that just works**: select to copy and right-click to paste. Copied text is cleaned up, wrapped lines are rejoined, and line endings become CRLF.
- **SFTP sidebar** that follows the terminal's current directory, even inside tmux.
- **Monaco editor** (from VS Code) plus PDF, Markdown, image and Office file support.
- **AI assistant** using your installed Claude Code / Codex CLI or any OpenAI-compatible API. Every server access needs your permission.

## Features

### Terminal & connections
- Built on xterm.js with GPU rendering, true color and full tmux support.
- Tabs and nested vertical/horizontal splits. `Alt+Arrow` moves focus between panes, and a status dot shows each session's state.
- **Select = copy** to the Windows clipboard, in a plain shell, in tmux and in full-screen programs.
- **Right-click = paste**. Middle-click, `Shift+Insert` and `Ctrl+Shift+V` also paste.
- The mouse wheel scrolls tmux history directly.
- Clicks reach mouse-aware programs such as opencode, htop and mc, while a drag still selects text.
- Server picker with search and keyboard navigation. You can add, edit, duplicate and reorder servers, and set an optional tmux session per server.
- **Login with a password or an SSH key** (OpenSSH/PEM, including encrypted keys).
  - Common errors get clear messages, for example choosing a `.pub` file, a PuTTY `.ppk` key, or a key missing from `authorized_keys`.
- Saved passwords and passphrases are encrypted with **Windows DPAPI**.
- Host keys are checked against `known_hosts`.
- **Auto-reconnect** uses keepalives (every 15 s by default) and retries with backoff. Keystrokes typed while disconnected are discarded, and typing `exit` ends the session normally.

### SFTP sidebar (`Ctrl+Shift+B`)
- Follows `cd` in the focused pane, with no `.bashrc` changes. Browsing manually pauses following.
- Upload and download files and folders with a per-file progress bar and cancel. Drag & drop from Windows Explorer to upload.
- Right-click menu: open, download, rename, delete, chmod, copy path, open in terminal. Multi-select works with `Ctrl`/`Shift`+click.

### Editor & viewers
- Double-click a file to open it in the **Monaco editor**. It offers:
  - syntax highlighting for 70+ languages
  - autocomplete and Tab snippets
  - IntelliSense for JS/TS/JSON/HTML/CSS
  - format document, command palette, find/replace and multi-cursor
- `Ctrl+S` saves back to the server. You are warned if the file changed on the server since you opened it, and asked before closing with unsaved changes. Text files up to 5 MB are supported.
- `.pdf`, `.md` and image files open in built-in viewers. Markdown HTML is sanitized.
- Office files (`.docx`, `.xlsx`, `.pptx`, …) open in Word, Excel, PowerPoint or LibreOffice and are **uploaded automatically on every save**.

### AI
- **AI Sidebar** (`Ctrl+Shift+A`) works with:
  - **Claude Code** and **Codex** CLIs: no extra login or API key
  - any **OpenAI-compatible API**: OpenAI, OpenRouter, Groq, DeepSeek, Ollama, LM Studio, …; keys are stored encrypted
- It is a normal chat by default. When a request needs the server, the AI can:
  - read the screen
  - run commands in the background
  - type keys into a program (e.g. opencode in tmux)
  - watch the screen for output
  - read and write files over SFTP
- **Each access asks permission**, split into *read* and *change*.
- The AI never types into your terminal unless you ask. A purple frame and a status badge show what it is doing.
- **Agent mode** lets the AI carry out a task visibly from start to finish: it finds the file, edits it in an editor tab, tests the result, fixes errors up to 5 rounds and reports what changed. Actions are approved automatically, **except risky ones**, which always ask.
- **AI Companion**: Copilot-style inline suggestions, requested **only** with `Alt+\` to save tokens. `Tab` accepts a suggestion. Each request is about 1–1.5k tokens.
- Usage is shown in the panel: Claude's 5-hour and 7-day limits, plus tokens and estimated cost per chat.

<details>
<summary><b>Agent mode in detail</b></summary>

1. **Reads the main screen.** At a shell prompt it works right there, and you see every command it types.
2. **If a coding agent is on screen** (opencode, Claude Code, Codex), it may hand a large task to that agent, follow its progress, then check the result.
3. **If any other program is on screen** (vim, htop, logs…), it opens a **new terminal tab** on the same server and folder instead of touching yours.
4. **Edits the file in an editor tab** with small, exact edits. Changes are highlighted, saved, and can be undone with `Ctrl+Z`.
5. **Tests the result** with a syntax or compile check that fits the file (`php -l`, `python3 -m py_compile`, `node --check`, `bash -n`, `go build`, `tsc`, `nginx -t`, …) and runs project tests if there are any.
6. **Fixes and retests** up to 5 rounds, then reports the files, lines, tests and result.

**Always-ask (risky) actions:** each of these shows a red prompt with no "allow all" option:
- deleting files
- wiping or formatting disks
- shutting down or rebooting
- stopping services or killing processes
- firewall changes
- `DROP` / `TRUNCATE` / `DELETE FROM`
- `git reset --hard` and force-push
- Docker/Kubernetes deletions
- recursive permission changes on system folders
- user or cron changes
- removing packages

*Stop* ends the work at any time. Files with unsaved changes are left alone.
</details>

## Optional programs

Everything else is built in. On first start, the app offers to install the missing optional programs via **winget**. You can open this check again any time with the 🔧 button.

| Program | Needed for | Install |
|---|---|---|
| Claude Code CLI | AI: Claude | `winget install Anthropic.ClaudeCode` |
| Codex CLI | AI: Codex | `winget install OpenAI.Codex` |
| Microsoft Office or LibreOffice | Editing Office files | `winget install TheDocumentFoundation.LibreOffice` |

## Updates

At start-up the app checks GitHub Releases in the background and does nothing if there is no update or no internet.

**Update** downloads the new `RemoteTerminal.exe` to your Downloads folder. To install it:
1. Close the app.
2. Replace the old `.exe` with the new one.
3. **Keep `config.toml` and `known_hosts`**. They hold your saved servers, encrypted passwords and settings.

<details>
<summary><b>Keyboard shortcuts</b></summary>

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+T` | New tab (server picker) |
| `Ctrl+Shift+E` / `Ctrl+Shift+O` | Split vertically / horizontally |
| `Ctrl+Shift+W` | Close pane / tab |
| `Alt+←/→/↑/↓` | Move focus between panes |
| `Ctrl+Tab`, `Ctrl+Shift+Tab`, `Ctrl+1…9` | Switch tabs |
| `Ctrl+Shift+B` | Toggle SFTP sidebar |
| `Ctrl+Shift+A` | Toggle AI Sidebar |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copy / paste |
| `Ctrl+Wheel`, `Ctrl+0` | Zoom font / reset |
| `F11` | Full screen |

**Editor shortcuts:**

| Shortcut | Action |
|---|---|
| `Ctrl+S` | Save |
| `F1` | Command palette |
| `Ctrl+Space` | Suggestions |
| `Shift+Alt+F` | Format |
| `Alt+Z` | Word wrap |
| `Ctrl+K M` | Change language |
| `Ctrl+F` / `Ctrl+H` | Find / replace |
| `Ctrl+/` | Comment |
| `Ctrl+G` | Go to line |
| `Alt+\` | Request an AI Companion suggestion |

Shortcuts use `Ctrl+Shift` so they don't clash with `Ctrl+W`, `Ctrl+T` or the tmux prefix `Ctrl+B`. All of them can be changed in `config.toml`.
</details>

<details>
<summary><b>Configuration (<code>config.toml</code>)</b></summary>

The file is created on first start and can be edited while the app is closed. **The file itself lists every setting and shortcut.** New options are written into it the next time the app saves its settings.

```toml
[settings]
  font_size = 14
  scrollback = 10000
  keepalive_seconds = 15
  tmux_mouse = true          # enable tmux mouse mode so the wheel scrolls history
  sidebar_follow = true
  editor_word_wrap = false
  ai_agent_mode = false
  ai_companion = false

[[profile]]
  name = "Production"
  host = "203.0.113.10"
  port = 22
  user = "deploy"
  password = "dpapi:AQAAANCMnd8BFdER..."   # DPAPI-encrypted; omit to be asked
  tmux_session = "main"                    # optional auto-attach/create

[[profile]]
  name = "Lab"
  host = "10.0.0.5"
  user = "admin"
  auth = "key"
  key_path = 'C:\Users\me\.ssh\id_ed25519' # "password" then holds the encrypted passphrase
```

OpenAI-compatible providers are added with `[[ai_provider]]`, or through ⚙ in the AI panel.
</details>

## Limitations

- No ssh-agent / Pageant support. PuTTY `.ppk` keys must be exported to OpenSSH format with PuTTYgen.
- Direct TCP connections only: no `ProxyCommand`, jump host or Cloudflare Tunnel yet.
- No drag from the sidebar to Explorer. Use Download instead.
- Windows only, because password encryption uses DPAPI.

## Development

**Requirements:** Windows 10/11, [Go](https://go.dev/dl/) 1.26+, [Node.js](https://nodejs.org/) 20+ and Git.

```powershell
git clone https://github.com/narayaitsolution/remote-access.git
cd remote-access
go install github.com/wailsapp/wails/v2/cmd/wails@v2.17.1   # once
.\build.ps1        # → build\bin\RemoteTerminal.exe
```

| Task | Command |
|---|---|
| Hot reload | `wails dev` |
| Tests (in-process fake SSH/SFTP server) | `go test ./...` |
| Live AI tests (uses a little quota) | `$env:RT_AI_TEST="claude"; go test -run TestAI -v .` (or `codex`) |
| Live update-check test | `$env:RT_UPDATE_TEST="1"; go test -run "TestCheckUpdateLive\|TestDownloadUpdateLive" -v .` |
| Type-check frontend | `cd frontend; npx tsc --noEmit` |
| Regenerate icon | `go run ./tools/mkicon assets/icon-source.png` |

`build.ps1` never cleans `build\bin`, so a test `config.toml` kept there is not deleted.

CI ([`build.yml`](.github/workflows/build.yml)) runs the tests and builds the `.exe` on every push and pull request.

**Releasing** (major = new feature, minor = fixes, small changes or docs):
1. Bump `appVersion` in `version.go` and `productVersion` in `wails.json`.
2. Add a row to [Version history](#version-history) and a `## <version>` section to [`CHANGELOG.id.md`](CHANGELOG.id.md). A test fails if the section is missing.
3. Tag and push: `git tag -a v11.1 -m "Remote Terminal 11.1"; git push; git push origin v11.1`.

GitHub Actions then publishes the `.exe` to Releases.

**Privacy:** `config.toml`, `known_hosts`, SSH keys and built `.exe` files are in `.gitignore`.

<details>
<summary><b>How it works & project layout</b></summary>

- The remote shell starts through a tiny hidden wrapper that reports its TTY and PID. A separate SSH channel then resolves the pane's tmux session and current directory. This is used for sidebar "follow" mode and for reconnecting.
- When a program enables mouse reporting, a left press is held back until it is clear whether it is a click or a drag. A click is replayed to the program; a drag starts a local selection.

| Path | Purpose |
|---|---|
| `main.go`, `app.go` | Wails setup, API for the UI |
| `session.go` | SSH, PTY, keepalive, reconnect, tmux/cwd tracking |
| `files.go` | SFTP operations and transfers |
| `auth.go`, `hostkey.go` | Password/key auth, `known_hosts` |
| `config.go`, `secret_*.go` | `config.toml`, DPAPI encryption |
| `ai.go`, `ai_openai.go` | AI CLIs + local MCP tool server; OpenAI-compatible providers |
| `localedit.go`, `winshell_*.go` | Editing in Windows apps with auto-upload |
| `update.go`, `version.go`, `deps.go` | Update check, version, winget setup |
| `fileicon*.go` | Windows Explorer file icons |
| `frontend/src/` | UI: `layout`, `pane`, `picker`, `sidebar`, `ai`, `editor`/`monaco`, `viewers`, `setup`, `about`, `fileicons` |
| `tools/mkicon`, `assets/` | Icon generation |
</details>

## Version history

The full Indonesian changelog is in [`CHANGELOG.id.md`](CHANGELOG.id.md) and in the app (ⓘ).

<details>
<summary><b>Show all versions</b></summary>

| Version | Type | Changes |
|---|---|---|
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

## Built with

[Wails](https://wails.io) · [xterm.js](https://xtermjs.org) · [Monaco Editor](https://microsoft.github.io/monaco-editor/) · [pdf.js](https://mozilla.github.io/pdf.js/) · [marked](https://marked.js.org) · [DOMPurify](https://github.com/cure53/DOMPurify) · [x/crypto/ssh](https://pkg.go.dev/golang.org/x/crypto/ssh) · [pkg/sftp](https://github.com/pkg/sftp) · [BurntSushi/toml](https://github.com/BurntSushi/toml)

## License

[MIT](LICENSE) © 2026 narayaitsolution
