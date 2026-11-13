# Remote Terminal

A lightweight, portable SSH terminal with an SFTP file sidebar for Windows — a focused alternative to MobaXterm for people who mostly live in `ssh` + `tmux`.

*[Bahasa Indonesia di bawah](#bahasa-indonesia)*

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
- Open the AI panel with `Ctrl+Shift+A` (or the **AI** button). It uses the AI CLIs already installed and logged in on your PC — **Claude Code** (`claude`) and **Codex** (`codex`) — so there is no extra login or API key.
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
- **Usage** is shown in the panel: for Claude, your subscription's 5-hour and 7-day limit utilisation (with reset time) plus tokens and estimated cost of the chat; for Codex, the tokens used by the chat.
- Each terminal pane has its own chat; *New chat* starts over. The AI CLIs run in an empty temporary folder with their own local tools disabled, so they can only act on the remote server through the app's tools (Codex additionally runs with a read-only sandbox).

### Built-in file editor (like VS Code)
- **Double-click a file in the sidebar** (or right-click → *Open in editor*) to open it in a new tab in the main area. The editor is **Monaco**, the editor component of VS Code: line numbers, syntax highlighting chosen from the file name (Python, JS/TS, Go, PHP, shell, YAML, JSON, Dockerfile, nginx/ini configs, …), minimap, find/replace (`Ctrl+F` / `Ctrl+H`), multi-cursor, bracket matching.
- **`Ctrl+S` saves** back to the server. The tab shows `●` while there are unsaved changes; a status bar shows line/column, indentation, line endings (LF/CRLF are preserved) and language.
- **Closing a tab with unsaved changes asks**: *Save*, *Don't save* or *Cancel*. Closing the whole app with unsaved files asks too.
- If the file was changed on the server since you opened it (by someone else, a script or an AI tool), saving warns you before overwriting.
- Text files up to 5 MB; binary files are refused (use Download).

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

Shortcuts use `Ctrl+Shift` so they don't clash with `Ctrl+W`, `Ctrl+T` or the tmux prefix `Ctrl+B`. All of them can be changed in `config.toml`.

## Configuration (`config.toml`)

Created automatically on first start. You can edit it with any text editor while the app is closed.

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

## Building from source

Requirements: [Go](https://go.dev/dl/) 1.24+, [Node.js](https://nodejs.org/) 20+, Windows 10/11.

```powershell
go install github.com/wailsapp/wails/v2/cmd/wails@latest
wails build -clean -trimpath -ldflags "-s -w"
# → build\bin\RemoteTerminal.exe
```

- Development mode with hot reload: `wails dev`
- Tests (in-process fake SSH server covering login, reconnect into tmux, keepalive timeout, SFTP transfers, password encryption): `go test ./...`

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

## Built with

[Wails](https://wails.io), [xterm.js](https://xtermjs.org), [golang.org/x/crypto/ssh](https://pkg.go.dev/golang.org/x/crypto/ssh), [pkg/sftp](https://github.com/pkg/sftp), [BurntSushi/toml](https://github.com/BurntSushi/toml).

## License

[MIT](LICENSE) © 2026 narayaitsolution

---

## Bahasa Indonesia

Aplikasi terminal SSH portable untuk Windows dengan sidebar file SFTP, alternatif ringan untuk MobaXterm bagi pengguna yang sehari-hari bekerja dengan `ssh` + `tmux`.

### Fitur utama
- **Satu file `.exe` tanpa instalasi.** Konfigurasi disimpan di file teks `config.toml` di samping `.exe`.
- **Halaman pemilihan server** di setiap tab/split baru: cari, pilih dengan panah, `Enter` untuk konek. Server bisa ditambah, diedit, diduplikat, dihapus, dan diurutkan.
- **Login dengan password atau SSH key** (id_rsa, id_ed25519, termasuk key yang memakai passphrase).
- **Password opsional disimpan**, dan jika disimpan **dienkripsi** dengan akun Windows Anda (DPAPI). Jika tidak disimpan, password ditanya setiap konek.
- **Tahan koneksi tidak stabil:** keepalive mendeteksi koneksi putus/macet, aplikasi menyambung ulang sendiri lalu **kembali ke sesi tmux terakhir**. Jika tmux tidak ada, tetap login ke shell biasa.
- **Scroll mouse langsung menggulir history tmux** tanpa menekan Shift.
- **Blok teks = langsung tersalin** ke clipboard Windows, tanpa spasi kosong di ujung baris dan dengan baris baru format Windows sehingga teks multi-baris rapi saat di-paste. **Klik kanan = paste.**
- **Tab dan split vertikal/horizontal** dengan shortcut cepat; setiap sesi baru dibuka dengan halaman pemilihan server.
- **Sidebar SFTP** yang bisa ditampilkan/disembunyikan, secara default **mengikuti folder kerja terminal**, dan bisa dinavigasi sendiri.
- **Toolbar ikon kecil satu baris:** naik folder, upload, download, file baru, folder baru, rename, hapus, refresh, ikuti terminal.
- **Menu klik kanan** untuk semua operasi file, pilih banyak file sekaligus, upload/download folder dengan progress bar, dan **drag & drop dari Windows Explorer** untuk upload.
- **Editor file seperti VS Code**: double-click file di sidebar untuk membukanya di tab baru (nomor baris, warna sintaks), `Ctrl+S` untuk menyimpan ke server, konfirmasi saat menutup tab yang belum disimpan.
- **Notifikasi (toast) di kanan atas** saat copy berhasil dan saat setiap operasi file berhasil/gagal.
- **Asisten AI (`Ctrl+Shift+A`)** memakai Claude Code / Codex yang sudah login di komputer ini, bisa memilih model, dan menampilkan usage (limit 5 jam / 7 hari untuk Claude). **Defaultnya chat biasa**; jika permintaan butuh server, AI **meminta izin** dulu untuk membaca layar/file, menjalankan perintah (terlihat di terminal), menulis file, atau **mengetik ke aplikasi yang sedang berjalan** seperti opencode di tmux.
- **Verifikasi host key** dengan peringatan jika kunci server berubah.

### Shortcut
`Ctrl+Shift+T` tab baru · `Ctrl+Shift+E` split vertikal · `Ctrl+Shift+O` split horizontal · `Ctrl+Shift+W` tutup · `Alt+Panah` pindah pane · `Ctrl+Tab` pindah tab · `Ctrl+Shift+B` sidebar · `F11` layar penuh. Semua bisa diubah di `config.toml`.

### Keterbatasan saat ini
- SSH key harus berformat OpenSSH/PEM; file PuTTY `.ppk` perlu di-export dulu lewat PuTTYgen.
- Belum mendukung koneksi lewat proxy/jump host/Cloudflare Tunnel.
- Download dengan drag dari sidebar ke Explorer belum didukung; gunakan tombol/menu Download.
