# Remote Terminal

**Current version: 10.0** — see [Version history](#version-history).

A lightweight, portable SSH terminal with an SFTP file sidebar for Windows — a focused alternative to MobaXterm for people who mostly live in `ssh` + `tmux`.

## Download

**[⬇ Download the latest `RemoteTerminal-<version>.exe` from Releases](https://github.com/narayaitsolution/remote-access/releases/latest)** — one portable file, no installation (Windows 10/11).

## Features

### Single portable `.exe`
- No installer. Copy `RemoteTerminal.exe` anywhere and run it.
- All settings are stored in a plain-text `config.toml` next to the `.exe` (falls back to `%APPDATA%\RemoteTerminal` if that folder is not writable).
- Requires only WebView2, which is preinstalled on current Windows 10/11.

### Server picker
- Every new tab or split opens a server list, like MobaXterm's start page.
- Search as you type, `↑/↓` + `Enter` to connect, double-click to connect.
- Add, edit, duplicate, delete and reorder servers.
- Optional per-server tmux session: connect straight into (or create) a named tmux session.

### Login: password or SSH key
- Each server uses either a **password** or an **SSH private key** (OpenSSH/PEM format such as `id_ed25519` or `id_rsa`; a browse button opens in `~/.ssh`).
- Encrypted keys are supported: the passphrase is asked only when the key needs one, and can be saved like a password.
- Clear messages for common mistakes: wrong passphrase, key not in the server's `authorized_keys`, choosing the `.pub` file, or a PuTTY `.ppk` file (export it to OpenSSH with PuTTYgen first).

### Passwords
- Saving the password (or key passphrase) is optional, per server.
- Saved passwords are encrypted with **Windows DPAPI**: only your Windows account on your PC can decrypt them. Copying `config.toml` to another machine does not reveal them.
- If not saved, you are asked for the password on every connect (and it is kept in memory only for automatic reconnects).

### Stable on unreliable networks
- SSH keepalives (default every 15 s) detect a dead or frozen connection instead of hanging forever.
- When the connection drops, the screen stays as it was, a small "Reconnecting…" badge appears, and the app retries with backoff.
- After reconnecting it **re-attaches the exact tmux session you were in**, so you continue where you left off. If tmux or that session no longer exists, you simply get a normal login shell.
- Keystrokes typed while disconnected are discarded rather than sent to the wrong place.
- Typing `exit` ends the session normally; it is not treated as a network drop. Press `Enter` to connect again.

### Terminal that behaves like you expect
- Based on xterm.js (the terminal used by VS Code) with GPU rendering, 256/true color and full tmux support.
- **Mouse wheel scrolls tmux history directly** — no Shift needed. (The app enables `mouse on` in your running tmux server; disable with `tmux_mouse = false`.)
- **Select = copy**: dragging always selects text locally, even inside tmux, and copies it to the Windows (host) clipboard — never to tmux on the server — with a "Copy berhasil" notification. Copied text is cleaned up: padding blanks are removed, text that a program wrapped to the screen width (padding the rest of the row with spaces) is joined back into flowing sentences, real line breaks are kept as Windows-style CRLF, so it pastes cleanly into Notepad or Word.
- **Right-click = paste** (also middle-click, `Shift+Insert`, `Ctrl+Shift+V`).
- `Ctrl+Wheel` changes the font size; `Ctrl+0` resets it.

### Tabs and splits
- Multiple sessions in tabs, each tab can be split **vertically** or **horizontally**, nested as deep as you like.
- Drag the divider to resize; `Alt+Arrow` moves focus between panes.
- Each tab shows a status dot: green = connected, yellow = connecting/reconnecting, red = ended.

### SFTP file sidebar
- Show/hide with `Ctrl+Shift+B`; drag its edge to resize.
- **Follows the terminal's current directory** by default — `cd` in the terminal and the sidebar goes there too (works inside tmux, no `.bashrc` changes needed). Browsing yourself pauses following; the "follow terminal" button turns it back on. With splits, the sidebar follows the focused pane.
- Compact one-row icon toolbar: **Up, Upload, Download, New file, New folder, Rename, Delete, Refresh, Follow terminal**.
- Editable path bar.
- **Right-click menu** on files/folders: Open, Download, Rename, Delete, Copy path, Change permissions (chmod), Open in terminal (`cd` there), Upload into this folder. Right-click on empty space: Upload, New file, New folder, Copy path, Open in terminal, Refresh.
- Multi-select with `Ctrl`/`Shift`+click; download or delete many items at once.
- Upload and download whole folders, with a progress bar per transfer and a cancel button. Click a finished download to open its folder in Explorer.
- **Drag & drop from Windows Explorer** onto the sidebar to upload (drop onto a folder row to upload into that folder).
- Keyboard: `Enter` open, `Backspace` up, `F2` rename, `Del` delete, `F5` refresh, `Ctrl+A` select all.

### AI assistant that works in your terminal
- Open the AI panel with `Ctrl+Shift+A` (or the **AI Sidebar** button). It uses the AI CLIs already installed and logged in on your PC — **Claude Code** (`claude`) and **Codex** (`codex`) — so there is no extra login or API key.
- Choose the provider and **model** per provider (Claude: opus / sonnet / haiku or a full model id; Codex: the models from your Codex installation). "Model lain…" accepts any model name.
- **It is a normal chat by default** — ask anything, even without a server connection. Only when a request needs the server does the AI use the tools the app provides, and **every server access asks your permission first**:
  - read the screen (including tmux history) and see which program is in the foreground,
  - run commands **in the background** (a separate hidden SSH channel in the terminal's current directory) — the default, so your screen is left alone,
  - run commands **typed into your visible terminal** when you ask for that, so you can watch them run,
  - type text and keys into whatever is running — e.g. **give instructions to opencode running in tmux**, answer prompts, navigate TUIs, `Ctrl+C` (supports Enter, Tab, Shift+Tab, Esc, arrows, F1–F12, Ctrl+key, Alt+key) — **only when you explicitly ask it to**,
  - watch the screen until some text appears or it stops changing (e.g. wait for opencode's answer),
  - list, read and write files over SFTP.
- Permissions are split into **read** (screen, files, folders) and **change** (commands, keys, writing files). Each request appears on the terminal itself and in the panel with *Allow*, *Deny*, or *Allow all reads / changes* for that chat; two checkboxes show and toggle the current choice.
- **Your screen is yours**: both Claude and Codex are instructed (as system/developer instructions) not to type into the terminal unless you ask. Asking "pwd" while opencode is open runs `pwd` in the background instead of typing into opencode. As a hard safety net, typing a shell command is refused whenever a program (opencode, vim, top…) is in the foreground instead of the shell prompt.
- While the AI works, the terminal gets a purple frame and a status badge ("AI: running command — df -h"), so you always see what it is doing.
- **Any OpenAI-compatible service** can be added as a provider (⚙ in the AI panel, or `[[ai_provider]]` in `config.toml`): base URL + API key (stored encrypted), e.g. OpenAI, OpenRouter, Groq, DeepSeek, Mistral, Together, or a local Ollama / LM Studio. Its models are read from `/models` (or listed manually) and appear in the model picker; *Test connection* checks URL and key. The app runs the tool loop itself (function calling), with the same permissions and on-screen visibility.
- **Usage** is shown in the panel: for Claude, your subscription's 5-hour and 7-day limit utilisation (with reset time) plus tokens and estimated cost of the chat; for Codex, the tokens used by the chat.
- Each terminal pane has its own chat; *New chat* starts over. The AI CLIs run in an empty temporary folder with their own local tools disabled, so they can only act on the remote server through the app's tools (Codex additionally runs with a read-only sandbox).

### Built-in code editor (like VS Code)
- **Double-click a file in the sidebar** (or right-click → *Open in editor*) to open it in a new tab in the main area. The editor is **Monaco**, the editor component of VS Code, so source code on the server can be edited directly: Python, PHP, Java, Go, C/C++, C#, JavaScript/TypeScript, Ruby, Rust, Kotlin, Swift, Lua, Perl, shell, PowerShell, SQL, HTML/CSS, YAML, JSON, XML, Dockerfile, nginx/ini configs and 70+ more languages.
- **Syntax highlighting** chosen from the file name; click the language in the status bar (or `Ctrl+K M`) to pick another one.
- **Autocomplete** (`Ctrl+Space`, or as you type): language keywords, common built-ins and words already in the file. **Snippets** like VS Code: type `def`, `class`, `for`, `if`, `try`, `main`, `foreach`, `iferr`, `sout`, … and press `Tab`; `Tab` then jumps between the placeholders.
- **Full IntelliSense** (errors, hover help, go to definition) for JavaScript, TypeScript, JSON, HTML and CSS.
- **Format document** (`Shift+Alt+F` or the *Format* button) for JSON, HTML, CSS, JavaScript and TypeScript.
- **Command palette** (`F1` or the *Perintah* button) with every editor command, as in VS Code.
- The usual VS Code editing: find/replace (`Ctrl+F` / `Ctrl+H`), multi-cursor (`Alt+Click`, `Ctrl+D`, `Ctrl+Alt+↑/↓`), move/copy lines (`Alt+↑/↓`, `Shift+Alt+↑/↓`), comment (`Ctrl+/`), code folding, sticky scroll, indent guides, bracket pair colours, auto-closing brackets and quotes, go to line (`Ctrl+G`).
- **Word wrap** on/off with `Alt+Z` or the *Wrap* button (remembered in `config.toml`). No minimap, so the code gets the full width.
- **`Ctrl+S` saves** back to the server. The tab shows `●` while there are unsaved changes; a status bar shows line/column, indentation, line endings (LF/CRLF are preserved) and language.
- **Closing a tab with unsaved changes asks**: *Save*, *Don't save* or *Cancel*. Closing the whole app with unsaved files asks too.
- If the file was changed on the server since you opened it (by someone else, a script or an AI tool), saving warns you before overwriting.
- Text files up to 5 MB; binary files are refused (use Download).

### AI Companion: inline code suggestions (like Copilot)
- **Off by default.** Click **AI Companion** in the top bar (next to **AI Sidebar**) to turn it on or off; the button turns purple while it is on. The choice is remembered.
- **Only on request, to save tokens:** nothing is sent while you type. Press **`Alt+\`** in the editor and a **grey suggestion** appears at the cursor: the rest of the line, or the next few lines. **`Tab`** accepts it, **`Ctrl+→`** accepts one word, **`Esc`** dismisses it. Typing the suggested characters keeps it visible without a new request; moving the cursor or typing something else drops it.
- **Small but complete context.** Each request sends:
  - the code around the cursor in full (about 3,000 characters before and 1,000 after, cut at whole lines);
  - an **outline** of the rest of the file: its imports/includes and the signatures of the nearest functions, classes and methods (bodies left out);
  - trailing spaces and runs of blank lines removed.

  A typical request is about 1,000–1,500 tokens however large the file is, and the model still knows what is imported and defined elsewhere.
- Uses an AI you have already connected; the provider and model are chosen separately from the AI Sidebar (right-click **AI Companion**, or click *AI Companion* in the editor status bar):
  - **OpenAI-compatible API** (OpenRouter, Groq, DeepSeek, OpenAI, a local Ollama / LM Studio, …): the fastest, usually under a second with a small model. Chosen first by default.
  - **Claude Code** (default model `haiku`) or **Codex**: work without an API key, but each suggestion takes a few seconds and uses your subscription quota.
- The editor status bar shows *AI Companion: Alt+\ / berpikir… / galat / mati* (hover for the error message).
- **Privacy:** only when you press `Alt+\`, the code around the cursor, the file outline and the file name are sent to the chosen provider.

### Viewing PDF, Markdown, images and Office files
Double-click a file in the sidebar and it opens in the main area according to its type:

| File | Opens as |
|---|---|
| `.pdf` | **PDF viewer** (pdf.js): all pages, zoom in/out, fit to width |
| `.md`, `.markdown` | **Markdown preview** (tables, code blocks, lists); *Edit* switches to the code editor, `Ctrl+S` saves. HTML in the file is sanitized, so scripts never run |
| `.png`, `.jpg`, `.gif`, `.webp`, `.svg`, `.bmp`, `.ico` | **Image viewer** (click to toggle actual size) |
| `.docx`, `.xlsx`, `.pptx` (and `.doc`, `.xls`, `.ppt`, `.odt`, `.ods`, `.odp`, `.rtf`) | **Edited in the Windows application** (Word, Excel, PowerPoint or LibreOffice). Every time you save there, the file is uploaded back to the server automatically; the sidebar shows its status and a *Done* button |
| everything else (`.txt`, code, configs, logs…) | **Code editor** |

Right-click → *Open with Windows application* works for any file type that has a program on your PC.

### Supporting programs (first-run check)
Everything marked *built-in* below is inside the `.exe`. On first start the app checks the optional programs and offers to install the missing ones with **winget** in one click; the dialog is available any time from the 🔧 button in the top bar. A feature whose program is missing stays disabled and offers *Install…* when you try to use it.

| Program | Needed for | Installed with |
|---|---|---|
| — (built-in) | Terminal, SFTP, code editor, PDF/Markdown/image viewers, AI via OpenAI-compatible URL | nothing to install |
| Microsoft Edge WebView2 | the app window | preinstalled on Windows 10/11 |
| Claude Code CLI | AI assistant: Claude | `winget install Anthropic.ClaudeCode` (+ one-time *Login*) |
| Codex CLI | AI assistant: Codex | `winget install OpenAI.Codex` (+ one-time *Login*) |
| Microsoft Office or LibreOffice | editing Word / Excel / PowerPoint files | `winget install TheDocumentFoundation.LibreOffice` |

### Notifications
- A small notification in the top-right corner confirms every copy and reports success or failure of every file action (upload, download, new file/folder, rename, delete, chmod, refresh, up).

### Security
- Host keys are checked against a `known_hosts` file next to the `.exe`. You confirm the fingerprint on first connect, and get a clear warning if a server's key changes.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+T` | New tab (opens server picker) |
| `Ctrl+Shift+E` | Split vertically (left \| right) |
| `Ctrl+Shift+O` | Split horizontally (top / bottom) |
| `Ctrl+Shift+W` | Close current pane / tab |
| `Alt+←/→/↑/↓` | Move focus between panes |
| `Ctrl+Tab`, `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl+1` … `Ctrl+9` | Jump to tab N |
| `Ctrl+Shift+B` | Show / hide sidebar |
| `Ctrl+Shift+C`, `Ctrl+Shift+V` | Copy / paste |
| `Ctrl+Wheel`, `Ctrl+0` | Zoom font / reset |
| `F11` | Full screen |
| `Ctrl+Shift+A` | Show / hide the AI assistant |

In the code editor: `Ctrl+S` save, `F1` command palette, `Ctrl+Space` suggestions, `Shift+Alt+F` format, `Alt+Z` word wrap, `Ctrl+K M` change language, `Ctrl+F` / `Ctrl+H` find / replace, `Ctrl+/` comment, `Ctrl+G` go to line. With AI Companion on: `Tab` accept suggestion, `Ctrl+→` accept one word, `Esc` dismiss, `Alt+\` request a suggestion.

Shortcuts use `Ctrl+Shift` so they don't clash with `Ctrl+W`, `Ctrl+T` or the tmux prefix `Ctrl+B`. All of them can be changed in `config.toml`.

## Configuration (`config.toml`)

Created automatically on first start. You can edit it with any text editor while the app is closed.

> **Always check `config.toml` itself for the complete configuration.** The example below shows only the most common options; the file next to the `.exe` (or in `%APPDATA%\RemoteTerminal`) lists every setting and every keyboard shortcut with its current value. Options added in newer versions are written into the file the next time the app saves its settings (for example after resizing the sidebar or toggling word wrap).

```toml
[settings]
  font_family = "'Cascadia Mono', Consolas, 'Courier New', monospace"
  font_size = 14
  scrollback = 10000
  copy_on_select = true
  sidebar_visible = true
  sidebar_width = 300
  sidebar_follow = true
  keepalive_seconds = 15
  tmux_mouse = true          # turn on tmux mouse mode so the wheel scrolls history
  download_dir = ""          # remembered last download folder
  editor_word_wrap = false   # code editor: wrap long lines (also toggled with Alt+Z)
  editor_tab_size = 4        # code editor: tab width when the file itself gives no hint
  ai_companion = false               # AI Companion inline suggestions (AI Companion button in the top bar; Alt+\ asks)
  ai_companion_provider = ""         # "claude", "codex" or "oa:<id>" of an [[ai_provider]]; "" = first usable
  ai_companion_model = ""            # e.g. "haiku"; "" = the provider's default

  [settings.keys]
    new_tab = "Ctrl+Shift+T"
    split_vertical = "Ctrl+Shift+E"
    split_horizontal = "Ctrl+Shift+O"
    close_pane = "Ctrl+Shift+W"
    toggle_sidebar = "Ctrl+Shift+B"
    # ... see the file for the full list

[[profile]]
  id = "3f9a1c2b7d10"
  name = "Production"
  host = "203.0.113.10"
  port = 22
  user = "deploy"
  password = "dpapi:AQAAANCMnd8BFdER..."   # encrypted; omit to be asked each time
  tmux_session = "main"                    # optional: auto-attach/create on connect

[[profile]]
  id = "8c1d0e4f5a22"
  name = "Lab"
  host = "10.0.0.5"
  port = 22
  user = "admin"
  auth = "key"                                   # log in with an SSH key
  key_path = 'C:\Users\me\.ssh\id_ed25519'       # "password" then holds the encrypted passphrase, if any
```

## Current limitations

- No ssh-agent / Pageant support; PuTTY `.ppk` keys must be exported to OpenSSH format.
- Direct TCP connections only (no `ProxyCommand` / jump host / Cloudflare Tunnel yet).
- Dragging files *from* the sidebar *to* Explorer is not supported; use Download (toolbar or right-click).
- Windows only (password encryption uses DPAPI).

## Development

Anyone can clone the repository and build or extend the app.

**Requirements:** Windows 10/11, [Go](https://go.dev/dl/) 1.26+, [Node.js](https://nodejs.org/) 20+ (npm), and Git.

```powershell
git clone https://github.com/narayaitsolution/remote-access.git
cd remote-access
go install github.com/wailsapp/wails/v2/cmd/wails@v2.17.1   # once; puts wails in %USERPROFILE%\go\bin
.\build.ps1
# → build\bin\RemoteTerminal-<version>.exe   (version from version.go)
```

`build.ps1` installs the frontend packages, builds the UI and compiles one portable `.exe`. It never cleans `build\bin`, so a `config.toml` you keep there for testing is not deleted.

| Task | Command |
|---|---|
| Run with hot reload while developing | `wails dev` |
| Go tests (in-process fake SSH/SFTP server: login, SSH keys, reconnect into tmux, keepalive timeout, transfers, editor save/conflict, OpenAI-compatible provider, password encryption, Windows file icons) | `go test ./...` |
| Live tests against the real AI CLIs (use your logged-in account and a little quota) | `$env:RT_AI_TEST="claude"; go test -run TestAI -v .` (or `codex`) |
| Type-check the frontend | `cd frontend; npx tsc --noEmit` |
| Regenerate the app icon from `assets/icon-source.png` | `go run ./tools/mkicon assets/icon-source.png` |

**Continuous integration:** every push and pull request runs the tests and builds the `.exe` on GitHub Actions ([`.github/workflows/build.yml`](.github/workflows/build.yml)); the build is attached to the run as an artifact.

**Releasing a new version** (major = new feature, minor = fixes/small changes/docs):
1. Change `appVersion` in `version.go` and `productVersion` in `wails.json`.
2. Add a row to [Version history](#version-history) .
3. Commit, then tag and push: `git tag -a v8.5 -m "Remote Terminal 8.5"; git push; git push origin v8.5`.
4. GitHub Actions builds `RemoteTerminal-8.5.exe` and publishes it on the [Releases](https://github.com/narayaitsolution/remote-access/releases) page, with the notes taken from the version-history row.

**Privacy:** personal files are never part of the repository. `config.toml` (servers, encrypted passwords, API keys), `known_hosts`, SSH keys and built `.exe` files are listed in `.gitignore`. Passwords and API keys are only ever stored DPAPI-encrypted on the user's own PC.

## How it works

- The remote shell is started through a tiny wrapper that reports the terminal's TTY and shell PID (hidden from the screen). With that, the app asks the server on a separate SSH channel which tmux session and directory belong to this terminal — used for the sidebar's "follow terminal" mode and to know where to return after a reconnect.
- Mouse drags are handled by xterm.js as local selection (the app makes it act as if Shift were held), while wheel events still go to tmux.

## Project layout

| Path | Purpose |
|---|---|
| `main.go`, `app.go` | Wails app setup and the API exposed to the UI |
| `session.go` | SSH connection, PTY, keepalive, auto-reconnect, tmux/cwd tracking |
| `files.go` | SFTP operations and transfers with progress |
| `hostkey.go` | `known_hosts` verification |
| `auth.go` | Password / SSH key authentication |
| `config.go`, `secret_*.go` | `config.toml` and DPAPI password encryption |
| `ai.go` | AI CLI processes (Claude Code / Codex) and the local MCP tool server |
| `session_test.go`, `ai_test.go` | Integration tests (`RT_AI_TEST=claude` or `codex` runs the live AI test) |
| `frontend/src/layout.ts` | Tabs, splits, focus, keyboard shortcuts |
| `frontend/src/pane.ts` | Terminal (xterm.js), mouse/clipboard behaviour, reconnect UI |
| `frontend/src/picker.ts` | Server list, profile editor, password prompt |
| `frontend/src/sidebar.ts` | SFTP file browser, context menu, transfers, drag & drop |
| `frontend/src/ai.ts` | AI panel: chat, approvals, tool execution in the terminal, usage |
| `frontend/src/editor.ts`, `monaco.ts` | File editor tabs (Monaco) with save, dirty tracking and conflict detection |
| `frontend/src/viewers.ts` | PDF, Markdown and image viewers |
| `frontend/src/setup.ts`, `deps.go` | First-run check and winget installation of supporting programs |
| `localedit.go`, `winshell_*.go` | Editing files in Windows applications with automatic upload |
| `ai_openai.go` | OpenAI-compatible providers (base URL + API key) |
| `fileicon*.go`, `frontend/src/fileicons.ts` | File-type icons taken from Windows (Explorer icons) |
| `version.go` | Application version |
| `build.ps1` | Builds `build\bin\RemoteTerminal-<version>.exe` |
| `.github/workflows/build.yml` | CI: tests + build on every push; publishes the `.exe` to Releases for `v*` tags |
| `assets/icon.svg`, `assets/icon-source.png`, `tools/mkicon` | App icon source; `go run ./tools/mkicon assets/icon-source.png` writes `build/appicon.png` and `build/windows/icon.ico` |

## Version history

Versioning scheme: the **major** number goes up when a new feature is added; the **minor** number goes up for fixes, small improvements and documentation. Each version is tagged in git (`v8.0`, `v7.0`, …).

| Version | Type | Changes |
|---|---|---|
| **10.0** | Feature | AI Companion: Copilot-style grey inline code suggestions in the editor, turned on/off with the new *AI Companion* button in the top bar; to save tokens a suggestion is requested only with `Alt+\` (`Tab` accepts) and sends the code around the cursor plus an outline of the rest of the file (imports and nearby signatures, about 1,000–1,500 tokens); the *AI* button is renamed *AI Sidebar*; works with OpenAI-compatible APIs, Claude Code or Codex, with its own provider/model choice; status shown in the editor status bar; new `ai_companion`, `ai_companion_provider`, `ai_companion_model` settings |
| **9.0** | Feature | Code editing like VS Code for Python, PHP, Java, Go, C/C++, C#, Ruby, Rust, Kotlin, shell, SQL and more: keyword/built-in autocomplete, Tab snippets, language picker in the status bar (`Ctrl+K M`), *Format* (`Shift+Alt+F`), command palette (`F1`), word wrap toggle (`Alt+Z`), sticky scroll and folding; minimap removed; new `editor_word_wrap` and `editor_tab_size` settings; README is English-only and points to `config.toml` for the full configuration |
| **8.4** | Minor | Executables are published on GitHub Releases, built automatically by GitHub Actions for every version tag; tests run on every push; the repository builds right after cloning (Development section in README); test data no longer contains personal names |
| **8.3** | Minor | New application icon (terminal window with a remote-connection signal) replacing the default framework "W" icon; `tools/mkicon` regenerates the icons from `assets/icon-source.png` |
| **8.2** | Minor | File icons in the SFTP sidebar now match Windows Explorer: each file type shows the icon of the program it opens with (PDF, Word, Excel, PowerPoint, text, archives, Python, …), with built-in icons as fallback |
| **8.1** | Minor | Fixed a grey box covering the title of the first tab ("Pilih…") on the server picker; `build.ps1` names the executable after the version (`RemoteTerminal-8.1.exe`) |
| **8.0** | Feature | PDF viewer, Markdown preview/edit, image viewer; editing Word/Excel/PowerPoint in the Windows application with automatic upload on save; *Open with Windows application* for any file; first-run check of supporting programs with one-click winget installation (Claude Code, Codex, LibreOffice) and *Login* buttons; version shown in the window title |
| **7.0** | Feature | AI providers via any OpenAI-compatible URL + API key (OpenAI, OpenRouter, Groq, DeepSeek, Ollama, LM Studio…), models listed in the AI panel, keys stored encrypted |
| **6.0** | Feature | Built-in file editor (Monaco, like VS Code): line numbers, syntax highlighting, `Ctrl+S` save, unsaved-changes prompt on close, conflict detection |
| **5.1** | Minor | AI no longer types into the user's screen unless asked; new background-command tool; Codex receives the rules as developer instructions |
| **5.0** | Feature | AI works as a normal chat by default; every server access needs permission (read / change); AI can drive programs running on screen (e.g. opencode in tmux); screen-watch tool; more special keys |
| **4.0** | Feature | AI assistant using the installed Claude Code / Codex: reads the screen, runs commands visibly, sends keys, reads/writes files; approvals; model choice; usage and limits |
| **3.1** | Minor | Documentation for SSH key login |
| **3.0** | Feature | Login with SSH private keys (OpenSSH/PEM, with passphrase support) |
| **2.1** | Minor | Copied text that a program wrapped to the screen width is joined back into flowing sentences |
| **2.0** | Feature | Top-right notifications for copy and for every file action (upload, download, create, rename, delete, refresh, up) |
| **1.2** | Minor | Multi-line copy uses Windows line breaks and drops padding spaces; MIT license |
| **1.1** | Minor | Detailed README with Indonesian section |
| **1.0** | Feature | First release: portable SSH terminal, server picker, tabs and splits, auto-reconnect into tmux, select-to-copy, SFTP sidebar following the terminal directory, upload/download, file management, drag & drop |

## Built with

[Wails](https://wails.io), [xterm.js](https://xtermjs.org), [Monaco Editor](https://microsoft.github.io/monaco-editor/), [pdf.js](https://mozilla.github.io/pdf.js/), [marked](https://marked.js.org), [DOMPurify](https://github.com/cure53/DOMPurify), [golang.org/x/crypto/ssh](https://pkg.go.dev/golang.org/x/crypto/ssh), [pkg/sftp](https://github.com/pkg/sftp), [BurntSushi/toml](https://github.com/BurntSushi/toml).

## License

[MIT](LICENSE) © 2026 narayaitsolution
