# Remote Terminal

A lightweight, portable SSH terminal with an SFTP file sidebar for Windows — a focused alternative to MobaXterm for people who mostly live in `ssh` + `tmux`.

- **One `.exe`, no installer.** Settings live in a plain-text `config.toml` next to the executable.
- **Server picker** on every new tab or split, with search and keyboard navigation.
- **Survives bad networks.** SSH keepalives detect dead connections; the app reconnects on its own and re-attaches the **same tmux session** you were in, so the drop is barely noticeable. If tmux is gone, you just get a normal shell.
- **Mouse that behaves:** the wheel scrolls tmux history directly (no Shift), and selecting text copies it to the Windows clipboard immediately. Right-click pastes.
- **Tabs and splits** (vertical / horizontal, nestable, resizable) with fast shortcuts.
- **SFTP sidebar** that follows your terminal's current directory, with upload/download (incl. folders), new file/folder, rename, delete, chmod, multi-select, right-click menu, and drag & drop from Windows Explorer.
- Passwords are optional to store; when stored they are encrypted with **Windows DPAPI** (only your Windows account can decrypt them).

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
| `Ctrl+Shift+C`, `Ctrl+Shift+V` | Copy / paste (also: select = copy, right-click = paste) |
| `Ctrl+Wheel`, `Ctrl+0` | Zoom font / reset |
| `F11` | Full screen |

In the sidebar: `Enter` open, `Backspace` up, `F2` rename, `Del` delete, `F5` refresh, `Ctrl+A` select all.
In the server picker: `↑/↓`, `Enter` connect, `Ctrl+N` new, `Ctrl+E` edit, `Del` delete.

All shortcuts can be changed in `config.toml` under `[settings.keys]`.

## How it works

- On connect the app starts the remote shell through a tiny wrapper that reports the terminal's TTY and shell PID. With that it can ask the server (on a separate SSH channel) which tmux session and directory this terminal is in — used both for the sidebar's "follow terminal" mode and to know where to return after a reconnect.
- With `tmux_mouse = true` (default) the app turns on `set -g mouse on` in your running tmux server so the wheel scrolls tmux history. Mouse drags are always handled locally for selection.
- Host keys are verified against a `known_hosts` file next to the `.exe`; you are asked on first connect and warned loudly if a key changes.

## Building from source

Requirements: [Go](https://go.dev/dl/) 1.24+, [Node.js](https://nodejs.org/) 20+, Windows 10/11 with WebView2 (preinstalled on current Windows).

```powershell
go install github.com/wailsapp/wails/v2/cmd/wails@latest
wails build -clean -trimpath -ldflags "-s -w"
# → build\bin\RemoteTerminal.exe
```

Development mode with hot reload: `wails dev`.
Run tests (uses an in-process fake SSH server): `go test ./...`

## Project layout

| Path | Purpose |
|---|---|
| `main.go`, `app.go` | Wails app setup and the API exposed to the UI |
| `session.go` | SSH connection, PTY, keepalive, auto-reconnect, tmux/cwd tracking |
| `files.go` | SFTP operations and transfers with progress |
| `hostkey.go` | `known_hosts` verification |
| `config.go`, `secret_*.go` | `config.toml` and DPAPI password encryption |
| `frontend/src/` | UI (TypeScript, no framework): `layout.ts` tabs/splits/shortcuts, `pane.ts` terminal (xterm.js), `picker.ts` server list, `sidebar.ts` file browser |

## Built with

[Wails](https://wails.io), [xterm.js](https://xtermjs.org), [golang.org/x/crypto/ssh](https://pkg.go.dev/golang.org/x/crypto/ssh), [pkg/sftp](https://github.com/pkg/sftp), [BurntSushi/toml](https://github.com/BurntSushi/toml).
