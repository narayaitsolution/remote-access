package main

// AI assistant integration.
//
// The app runs the user's already-logged-in AI CLI (Claude Code or Codex) as a
// child process and gives it tools through a small MCP server on 127.0.0.1.
// Every tool call is forwarded to the UI, which shows it, asks for approval
// when it changes something, executes it in the visible terminal, and returns
// the result. The CLIs' own local tools are disabled so the AI can only act on
// the remote server through these tools.

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type aiChat struct {
	id       string
	provider string
	model    string
	context  string
	session  string // CLI conversation id, used to resume
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	running  bool
	// OpenAI-compatible providers: conversation kept here, cancel stops the loop.
	history []map[string]any
	cancel  context.CancelFunc
}

type aiState struct {
	mu      sync.Mutex
	srv     *http.Server
	port    int
	token   string
	chats   map[string]*aiChat
	pending map[string]chan aiToolResult
}

type aiToolResult struct {
	Text    string
	IsError bool
}

// ---------- tool definitions ----------

type mcpTool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

func obj(props map[string]any, required ...string) map[string]any {
	s := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

func str(desc string) map[string]any { return map[string]any{"type": "string", "description": desc} }
func num(desc string) map[string]any { return map[string]any{"type": "number", "description": desc} }

var aiTools = []mcpTool{
	{"read_screen", "Read the text currently visible in the user's terminal (the remote server shell, or a program running in it such as opencode, vim or htop, often inside tmux). Also reports which program is in the foreground. Optionally include earlier history lines. Needs the user's permission.",
		obj(map[string]any{"history_lines": num("Extra lines of scrollback/history above the visible screen to include (0-2000). Default 0.")})},
	{"run_background", "Run a shell command on the remote server in a separate, hidden session. It does NOT appear on or interfere with the user's screen, and starts in the terminal's current directory. This is the default way to run commands for information or work (e.g. pwd, ls, df -h, systemctl status, git log). Needs the user's permission. Non-interactive commands only; no shell aliases or state from the user's terminal.",
		obj(map[string]any{
			"command":         str("The command line to run (bash)."),
			"timeout_seconds": num("Maximum run time (5-600). Default 60."),
		}, "command")},
	{"run_command", "Type a shell command into the user's VISIBLE terminal, press Enter, wait for it to finish and return its output and exit code. Use it only when the user wants to see/run it in their terminal (or the change must happen in that shell, e.g. cd, activating a virtualenv); otherwise use run_background. Only works when the shell prompt is in the foreground; it is refused while a program such as opencode, vim or top is running. Single line; commands that finish on their own (no editors/pagers). Needs the user's permission.",
		obj(map[string]any{
			"command":         str("The exact command line to run (bash), on one line."),
			"timeout_seconds": num("How long to wait for completion (5-600). Default 60. If it is still running afterwards, the current screen is returned."),
		}, "command")},
	{"send_keys", "Type text and/or keys into whatever is running in the user's terminal. Use it ONLY when the user explicitly asks you to interact with the program on their screen (e.g. \"tell opencode to …\", \"press q\", \"answer yes\", \"stop it with Ctrl+C\"). NEVER use it to run a shell command for your own purposes (use run_background), and never type into an application such as opencode unless the user asked for that. Needs the user's permission. Special keys in angle brackets: <Enter> <Tab> <S-Tab> <Esc> <Backspace> <Delete> <Up> <Down> <Left> <Right> <Home> <End> <PageUp> <PageDown> <F1>..<F12> <Space>, <C-x> for Ctrl+letter (e.g. <C-c>, <C-d>, <C-b> is the tmux prefix), <M-x> for Alt+letter. Returns the screen after wait_ms.",
		obj(map[string]any{
			"keys":    str("Text and special keys, e.g. \"q\", \"y<Enter>\", \"<C-c>\", \"fix the failing test<Enter>\"."),
			"wait_ms": num("Milliseconds to wait before reading the screen back (100-10000). Default 800."),
		}, "keys")},
	{"wait_for_screen", "Watch the user's terminal until some text appears, or until the screen stops changing, then return it. Use it after send_keys to an interactive program (e.g. wait for opencode to finish answering). Needs the user's permission (it reads the screen).",
		obj(map[string]any{
			"until_text": str("Return as soon as this text is visible on the screen (optional)."),
			"seconds":    num("Maximum time to wait (1-300). Default 30."),
			"stable_ms":  num("Without until_text: return once the screen has not changed for this long (500-30000). Default 2000."),
		})},
	{"list_dir", "List a directory on the remote server (name, type, size, modification time). Needs the user's permission.",
		obj(map[string]any{"path": str("Absolute path, or ~ for home.")}, "path")},
	{"read_file", "Read a text file from the remote server. Needs the user's permission.",
		obj(map[string]any{
			"path":      str("Absolute path of the file."),
			"max_bytes": num("Maximum bytes to read (default 200000)."),
		}, "path")},
	{"write_file", "Create or overwrite a text file on the remote server with the given content. The user sees the content and must approve it first.",
		obj(map[string]any{
			"path":    str("Absolute path of the file."),
			"content": str("Full new content of the file."),
		}, "path", "content")},
}

// ---------- MCP server (streamable HTTP, JSON responses only) ----------

func (a *App) ensureMCP() error {
	a.ai.mu.Lock()
	defer a.ai.mu.Unlock()
	if a.ai.srv != nil {
		return nil
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	b := make([]byte, 24)
	rand.Read(b)
	a.ai.token = hex.EncodeToString(b)
	a.ai.port = ln.Addr().(*net.TCPAddr).Port
	mux := http.NewServeMux()
	mux.HandleFunc("/mcp/", a.handleMCP)
	a.ai.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go a.ai.srv.Serve(ln)
	return nil
}

func (a *App) mcpURL(chatID string) string {
	return fmt.Sprintf("http://127.0.0.1:%d/mcp/%s", a.ai.port, chatID)
}

type rpcReq struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

func (a *App) handleMCP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+a.ai.token {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	chatID := strings.TrimPrefix(r.URL.Path, "/mcp/")
	var req rpcReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 10<<20)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if len(req.ID) == 0 { // notification
		w.WriteHeader(http.StatusAccepted)
		return
	}
	var result any
	var rpcErr map[string]any
	switch req.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		json.Unmarshal(req.Params, &p)
		if p.ProtocolVersion == "" {
			p.ProtocolVersion = "2025-06-18"
		}
		result = map[string]any{
			"protocolVersion": p.ProtocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "remote-terminal", "version": appVersion},
		}
	case "ping":
		result = map[string]any{}
	case "tools/list":
		result = map[string]any{"tools": aiTools}
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		json.Unmarshal(req.Params, &p)
		res := a.callTool(r.Context(), chatID, p.Name, p.Arguments)
		result = map[string]any{
			"content": []map[string]any{{"type": "text", "text": res.Text}},
			"isError": res.IsError,
		}
	default:
		rpcErr = map[string]any{"code": -32601, "message": "method not found"}
	}
	resp := map[string]any{"jsonrpc": "2.0", "id": req.ID}
	if rpcErr != nil {
		resp["error"] = rpcErr
	} else {
		resp["result"] = result
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// callTool forwards a tool call to the UI and waits for its result.
func (a *App) callTool(ctx context.Context, chatID, name string, args json.RawMessage) aiToolResult {
	known := false
	for _, t := range aiTools {
		known = known || t.Name == name
	}
	if !known {
		return aiToolResult{"unknown tool " + name, true}
	}
	reqID := newID()
	ch := make(chan aiToolResult, 1)
	a.ai.mu.Lock()
	a.ai.pending[reqID] = ch
	a.ai.mu.Unlock()
	defer func() {
		a.ai.mu.Lock()
		delete(a.ai.pending, reqID)
		a.ai.mu.Unlock()
	}()
	if len(args) == 0 {
		args = json.RawMessage("{}")
	}
	a.emit("ai:tool", map[string]any{"reqId": reqID, "chatId": chatID, "name": name, "args": args})
	select {
	case res := <-ch:
		return res
	case <-ctx.Done():
		a.emit("ai:toolCancel", reqID)
		return aiToolResult{"cancelled", true}
	case <-time.After(20 * time.Minute):
		a.emit("ai:toolCancel", reqID)
		return aiToolResult{"timed out waiting for the user", true}
	}
}

// AIToolResult is called by the UI when a tool call has finished.
func (a *App) AIToolResult(reqID string, isError bool, text string) {
	a.ai.mu.Lock()
	ch := a.ai.pending[reqID]
	a.ai.mu.Unlock()
	if ch != nil {
		select {
		case ch <- aiToolResult{text, isError}:
		default:
		}
	}
}

// ---------- agent processes ----------

type AIProviderInfo struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Installed    bool     `json:"installed"`
	Path         string   `json:"path"`
	Models       []string `json:"models"`
	DefaultModel string   `json:"defaultModel"`
	Kind         string   `json:"kind"` // "cli" (Claude Code, Codex) or "openai" (OpenAI-compatible URL)
}

// AIProviders reports which AI CLIs are installed and suggested models.
func (a *App) AIProviders() []AIProviderInfo {
	claude, _ := exec.LookPath("claude")
	codex, _ := exec.LookPath("codex")
	codexDefault := readCodexDefaultModel()
	codexModels := readCodexModels()
	if codexDefault != "" && !contains(codexModels, codexDefault) {
		codexModels = append([]string{codexDefault}, codexModels...)
	}
	if len(codexModels) == 0 {
		codexModels = []string{""} // empty = Codex's own default
	}
	list := []AIProviderInfo{
		{ID: "claude", Name: "Claude Code", Installed: claude != "", Path: claude, Kind: "cli",
			Models: []string{"opus", "sonnet", "haiku", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"}, DefaultModel: "sonnet"},
		{ID: "codex", Name: "Codex", Installed: codex != "", Path: codex, Kind: "cli",
			Models: codexModels, DefaultModel: firstNonEmpty(codexDefault, codexModels[0])},
	}
	return append(list, a.openAIProviderInfos()...)
}

func readCodexDefaultModel() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(home, ".codex", "config.toml"))
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") {
			break // only top-level keys
		}
		if k, v, ok := strings.Cut(line, "="); ok && strings.TrimSpace(k) == "model" {
			return strings.Trim(strings.TrimSpace(v), `"'`)
		}
	}
	return ""
}

// readCodexModels lists the models Codex itself offers (~/.codex/models_cache.json).
func readCodexModels() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	data, err := os.ReadFile(filepath.Join(home, ".codex", "models_cache.json"))
	if err != nil {
		return nil
	}
	var cache struct {
		Models []struct {
			Slug       string `json:"slug"`
			Visibility string `json:"visibility"`
		} `json:"models"`
	}
	if json.Unmarshal(data, &cache) != nil {
		return nil
	}
	var out []string
	for _, m := range cache.Models {
		if m.Slug != "" && m.Visibility != "hide" {
			out = append(out, m.Slug)
		}
	}
	return out
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func firstNonEmpty(s ...string) string {
	for _, x := range s {
		if x != "" {
			return x
		}
	}
	return ""
}

func aiWorkDir() string {
	dir := filepath.Join(os.TempDir(), "remote-terminal-ai")
	os.MkdirAll(dir, 0o700)
	return dir
}

func aiSystemPrompt(context string) string {
	return `You are a helpful assistant built into "Remote Terminal", an SSH client the user is working in.
` + context + `

Default to being a normal chat assistant: answer questions, explain, write code or commands, discuss ideas — without touching the server. Most messages need no tools.

Use the remote-terminal tools only when the request actually needs the server or the terminal (e.g. "check why nginx fails", "what is on my screen", "read /etc/hosts", "type this into opencode"). Every tool use asks the user for permission, so use them purposefully and say briefly why before using one.
The tools act on the remote server and the user's terminal only, never on the user's local Windows PC:
- run_background: run commands in a hidden session (default for any command, e.g. "pwd", "ls", checking a service). Does not touch the user's screen.
- list_dir / read_file / write_file: files on the server.
- read_screen: see the terminal, including programs running in it (opencode, vim, htop…) and which program is in the foreground.
- run_command: type a command into the user's visible shell — only when the user asks to run it in their terminal, or the change must happen in that shell.
- send_keys + wait_for_screen: interact with the program on the user's screen — e.g. type a request into opencode, answer a prompt, <C-c>.

THE USER'S SCREEN BELONGS TO THE USER. Do not type into it (send_keys / run_command) unless the user explicitly asked for that. In particular, if a program such as opencode, vim or htop is in the foreground, never type into it on your own initiative — a request like "run pwd" or "check the disk" means run_background, not typing into that program. Only interact with that program when the user says so (e.g. "tell opencode to …").
Ask before destructive or irreversible actions (deleting data, restarting production services, firewall changes). If the user denies a tool, do not retry it; continue the conversation or ask what they prefer.
Reply in the same language the user writes in.`
}

// AISend sends a user message to the chat's AI, starting the CLI if needed.
func (a *App) AISend(chatID, provider, model, text, context string) error {
	if err := a.ensureMCP(); err != nil {
		return err
	}
	a.ai.mu.Lock()
	c := a.ai.chats[chatID]
	if c == nil {
		c = &aiChat{id: chatID}
		a.ai.chats[chatID] = c
	}
	if c.provider != provider {
		c.session, c.history = "", nil // a conversation cannot move between providers
	}
	restart := c.running && (c.provider != provider || c.model != model || c.context != context)
	c.provider, c.model, c.context = provider, model, context
	a.ai.mu.Unlock()

	switch provider {
	case "claude":
		if restart {
			a.stopChat(c)
		}
		if err := a.startClaude(c); err != nil {
			return err
		}
		line, _ := json.Marshal(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": text}})
		a.ai.mu.Lock()
		stdin := c.stdin
		a.ai.mu.Unlock()
		_, err := stdin.Write(append(line, '\n'))
		return err
	case "codex":
		return a.runCodex(c, text)
	}
	if strings.HasPrefix(provider, oaPrefix) {
		if c.history != nil && len(c.history) > 0 && c.context != context {
			c.history[0] = map[string]any{"role": "system", "content": aiSystemPrompt(context)}
		}
		return a.runOpenAI(c, text)
	}
	return errors.New("provider tidak dikenal")
}

func (a *App) startClaude(c *aiChat) error {
	a.ai.mu.Lock()
	if c.running {
		a.ai.mu.Unlock()
		return nil
	}
	session, model, context := c.session, c.model, c.context
	a.ai.mu.Unlock()
	path, err := exec.LookPath("claude")
	if err != nil {
		return errors.New("Claude Code (claude) tidak ditemukan di PATH")
	}
	mcp, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{"rt": map[string]any{
		"type": "http", "url": a.mcpURL(c.id), "headers": map[string]string{"Authorization": "Bearer " + a.ai.token},
	}}})
	args := []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
		"--tools", "", "--strict-mcp-config", "--mcp-config", string(mcp), "--allowedTools", "mcp__rt",
		"--setting-sources", "", "--append-system-prompt", aiSystemPrompt(context)}
	if model != "" {
		args = append(args, "--model", model)
	}
	if session != "" {
		args = append(args, "--resume", session)
	}
	cmd := exec.Command(path, args...)
	cmd.Dir = aiWorkDir()
	hideWindow(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	return a.startAgent(c, cmd, stdin)
}

// runCodex runs one Codex turn (codex exec is one process per message).
func (a *App) runCodex(c *aiChat, text string) error {
	a.ai.mu.Lock()
	if c.running {
		a.ai.mu.Unlock()
		return errors.New("Codex masih bekerja; tunggu atau tekan Stop")
	}
	session, model, context := c.session, c.model, c.context
	a.ai.mu.Unlock()
	path, extraEnv, native, err := codexBinary()
	if err != nil {
		return err
	}
	instructions := aiSystemPrompt(context) + "\nNever use your own built-in shell tool: it runs on the user's local Windows PC, not on the server."
	args := []string{"exec"}
	if session != "" {
		args = append(args, "resume", session)
	}
	args = append(args, "--json", "--skip-git-repo-check",
		"-c", `sandbox_mode="read-only"`,
		"-c", "mcp_servers.rt.url="+a.mcpURL(c.id),
		"-c", "mcp_servers.rt.bearer_token_env_var=RT_MCP_TOKEN",
		"-c", "mcp_servers.rt.tool_timeout_sec=1200",
		// Approval happens in our UI; Codex must not block on its own prompt.
		"-c", `mcp_servers.rt.default_tools_approval_mode="approve"`,
	)
	if native {
		// Rules as real developer instructions (same strength as Claude's system prompt).
		// JSON string syntax is a valid TOML basic string.
		q, _ := json.Marshal(instructions)
		args = append(args, "-c", "developer_instructions="+string(q))
	}
	if model != "" {
		args = append(args, "-m", model)
	}
	args = append(args, "-") // prompt from stdin
	cmd := exec.Command(path, args...)
	cmd.Dir = aiWorkDir()
	cmd.Env = append(append(os.Environ(), extraEnv...), "RT_MCP_TOKEN="+a.ai.token)
	hideWindow(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	if err := a.startAgent(c, cmd, stdin); err != nil {
		return err
	}
	prompt := text
	if !native && session == "" {
		// Fallback when only the npm .cmd shim is available (cmd.exe cannot carry the long argument).
		prompt = "<instructions>\n" + instructions + "\n</instructions>\n\n" + text
	}
	io.WriteString(stdin, prompt)
	stdin.Close()
	return nil
}

// codexBinary finds the native codex.exe behind the npm shim, so arguments are
// passed directly instead of through cmd.exe. It sets the same environment the
// npm launcher (bin/codex.js) sets. native=false means only the shim was found.
func codexBinary() (path string, env []string, native bool, err error) {
	shim, err := exec.LookPath("codex")
	if err != nil {
		return "", nil, false, errors.New("Codex (codex) tidak ditemukan di PATH")
	}
	if strings.EqualFold(filepath.Ext(shim), ".exe") {
		return shim, nil, true, nil
	}
	root := filepath.Join(filepath.Dir(shim), "node_modules", "@openai", "codex")
	for _, t := range []struct{ pkg, triple string }{
		{"codex-win32-x64", "x86_64-pc-windows-msvc"},
		{"codex-win32-arm64", "aarch64-pc-windows-msvc"},
	} {
		for _, vendor := range []string{
			filepath.Join(root, "node_modules", "@openai", t.pkg, "vendor"),
			filepath.Join(root, "vendor"),
		} {
			exe := filepath.Join(vendor, t.triple, "bin", "codex.exe")
			if _, err := os.Stat(exe); err == nil {
				return exe, []string{"CODEX_MANAGED_PACKAGE_ROOT=" + root, "CODEX_MANAGED_BY_NPM=1"}, true, nil
			}
		}
	}
	return shim, nil, false, nil
}

func (a *App) startAgent(c *aiChat, cmd *exec.Cmd, stdin io.WriteCloser) error {
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	var stderr strings.Builder
	cmd.Stderr = &limitedWriter{w: &stderr, n: 8000}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("gagal menjalankan %s: %w", filepath.Base(cmd.Path), err)
	}
	a.ai.mu.Lock()
	c.cmd, c.stdin, c.running = cmd, stdin, true
	a.ai.mu.Unlock()
	a.emit("ai:state:"+c.id, map[string]any{"running": true})
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 1<<20), 32<<20)
		for sc.Scan() {
			line := sc.Text()
			a.captureSession(c, line)
			a.emit("ai:line:"+c.id, line)
		}
		err := cmd.Wait()
		a.ai.mu.Lock()
		stillOurs := c.cmd == cmd
		if stillOurs {
			c.running, c.cmd, c.stdin = false, nil, nil
		}
		a.ai.mu.Unlock()
		msg := ""
		if err != nil && stillOurs {
			msg = strings.TrimSpace(stderr.String())
			if msg == "" {
				msg = err.Error()
			}
		}
		a.emit("ai:state:"+c.id, map[string]any{"running": false, "error": msg})
	}()
	return nil
}

// captureSession remembers the CLI's conversation id so it can be resumed.
func (a *App) captureSession(c *aiChat, line string) {
	var ev struct {
		Type      string `json:"type"`
		SessionID string `json:"session_id"`
		ThreadID  string `json:"thread_id"`
	}
	if json.Unmarshal([]byte(line), &ev) != nil {
		return
	}
	id := firstNonEmpty(ev.SessionID, ev.ThreadID)
	if id != "" {
		a.ai.mu.Lock()
		c.session = id
		a.ai.mu.Unlock()
	}
}

func (a *App) stopChat(c *aiChat) {
	a.ai.mu.Lock()
	cmd, cancel := c.cmd, c.cancel
	c.running, c.cmd, c.stdin, c.cancel = false, nil, nil, nil
	a.ai.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if cmd != nil && cmd.Process != nil {
		killTree(cmd)
	}
}

// AIStop interrupts the AI. The conversation can continue with the next message.
func (a *App) AIStop(chatID string) {
	a.ai.mu.Lock()
	c := a.ai.chats[chatID]
	a.ai.mu.Unlock()
	if c != nil {
		a.stopChat(c)
		a.emit("ai:state:"+chatID, map[string]any{"running": false, "stopped": true})
	}
}

// AIReset forgets the conversation (new chat).
func (a *App) AIReset(chatID string) {
	a.AIStop(chatID)
	a.ai.mu.Lock()
	delete(a.ai.chats, chatID)
	a.ai.mu.Unlock()
}

func (a *App) shutdownAI() {
	a.ai.mu.Lock()
	chats := make([]*aiChat, 0, len(a.ai.chats))
	for _, c := range a.ai.chats {
		chats = append(chats, c)
	}
	srv := a.ai.srv
	a.ai.mu.Unlock()
	for _, c := range chats {
		a.stopChat(c)
	}
	if srv != nil {
		srv.Close()
	}
}

type limitedWriter struct {
	mu sync.Mutex
	w  *strings.Builder
	n  int
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if room := l.n - l.w.Len(); room > 0 {
		if len(p) > room {
			l.w.Write(p[:room])
		} else {
			l.w.Write(p)
		}
	}
	return len(p), nil
}
