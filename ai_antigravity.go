package main

// Google AI through the Antigravity CLI (agy), signed in with the user's own
// Google account on this PC. agy is driven over the Agent Client Protocol
// (`agy acp`, JSON-RPC on stdio): one process per chat, our MCP server is
// handed to it per session, and the system prompt goes in through
// Antigravity's systemPrompt.append extension.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const agyMCPPrefix = "mcp_rt_" // agy names our MCP tools mcp_<server>_<tool>

// agyPath finds the Antigravity CLI: on PATH, or where its installer puts it.
func agyPath() (string, error) {
	if p, err := exec.LookPath("agy"); err == nil {
		return p, nil
	}
	if d := os.Getenv("LOCALAPPDATA"); d != "" {
		if p := filepath.Join(d, "agy", "bin", "agy.exe"); fileExists(p) {
			return p, nil
		}
	}
	return "", errors.New(L("Antigravity CLI (agy) tidak ditemukan", "Antigravity CLI (agy) was not found"))
}

// Models offered when `agy models` cannot be asked (offline, not signed in).
var agyFallbackModels = []string{
	"gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low",
	"claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium",
}

var agyModels struct {
	sync.Mutex
	list []string
	at   time.Time
}

// readAgyModels lists the models this Google account can use (cached 10 min).
func readAgyModels(path string) []string {
	agyModels.Lock()
	defer agyModels.Unlock()
	if agyModels.list != nil && time.Since(agyModels.at) < 10*time.Minute {
		return agyModels.list
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "models")
	cmd.Dir = aiWorkDir()
	hideWindow(cmd)
	out, _ := cmd.Output()
	list := parseAgyModels(string(out))
	if len(list) == 0 {
		return agyFallbackModels // not cached: try again next time
	}
	agyModels.list, agyModels.at = list, time.Now()
	return list
}

// parseAgyModels reads `agy models` output: "<id>\t<display name>" per line.
func parseAgyModels(out string) []string {
	var list []string
	for _, line := range strings.Split(out, "\n") {
		id, _, ok := strings.Cut(strings.TrimSpace(line), "\t")
		if ok && id != "" && !strings.ContainsAny(id, " :") {
			list = append(list, id)
		}
	}
	return list
}

func antigravityInfo() AIProviderInfo {
	path, err := agyPath()
	info := AIProviderInfo{ID: "antigravity", Name: "Google Antigravity", Installed: err == nil, Path: path, Kind: "cli",
		Models: agyFallbackModels, DefaultModel: agyFallbackModels[0]}
	if err == nil {
		info.Models = readAgyModels(path)
		info.DefaultModel = info.Models[0]
	}
	return info
}

// ---------- ACP connection ----------

type acpMsg struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type acpConn struct {
	cmd     *exec.Cmd
	wmu     sync.Mutex
	enc     *json.Encoder
	next    atomic.Int64
	pmu     sync.Mutex
	pending map[int64]chan acpMsg
	loading atomic.Bool // drop the history replay of session/load
	done    chan struct{}
	stderr  *limitedWriter
	session string
	context string // aiChat.context the session was created with
	model   string // model last set on the session
}

func (k *acpConn) send(m any) error {
	k.wmu.Lock()
	defer k.wmu.Unlock()
	return k.enc.Encode(m)
}

// call sends a request and waits for its response (or the process to end).
func (k *acpConn) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := k.next.Add(1)
	ch := make(chan acpMsg, 1)
	k.pmu.Lock()
	k.pending[id] = ch
	k.pmu.Unlock()
	defer func() { k.pmu.Lock(); delete(k.pending, id); k.pmu.Unlock() }()
	if err := k.send(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		return nil, err
	}
	select {
	case m := <-ch:
		if m.Error != nil {
			return nil, errors.New(m.Error.Message)
		}
		return m.Result, nil
	case <-k.done:
		return nil, k.exitError()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (k *acpConn) exitError() error {
	if msg := strings.TrimSpace(k.stderr.w.String()); msg != "" {
		return errors.New(msg)
	}
	return errors.New(L("Antigravity berhenti", "Antigravity stopped"))
}

func (k *acpConn) kill() {
	if k.cmd.Process != nil {
		killTree(k.cmd)
	}
}

// startACP launches `agy acp` for a chat and reads its messages.
func (a *App) startACP(c *aiChat) (*acpConn, error) {
	path, err := agyPath()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(path, "acp")
	cmd.Dir = aiWorkDir()
	hideWindow(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	k := &acpConn{cmd: cmd, enc: json.NewEncoder(stdin), pending: map[int64]chan acpMsg{},
		done: make(chan struct{}), stderr: &limitedWriter{w: &strings.Builder{}, n: 8000}}
	cmd.Stderr = k.stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf(L("gagal menjalankan %s: %w", "failed to run %s: %w"), filepath.Base(path), err)
	}
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 1<<20), 32<<20)
		for sc.Scan() {
			var m acpMsg
			if json.Unmarshal(sc.Bytes(), &m) != nil {
				continue
			}
			a.onACP(c, k, m)
		}
		cmd.Wait()
		close(k.done)
		a.ai.mu.Lock()
		ours := c.acp == k
		wasRunning := ours && c.running
		if ours {
			c.acp, c.cmd, c.running = nil, nil, false
		}
		a.ai.mu.Unlock()
		if wasRunning {
			a.emit("ai:state:"+c.id, map[string]any{"running": false, "error": k.exitError().Error()})
		}
	}()
	return k, nil
}

func (a *App) onACP(c *aiChat, k *acpConn, m acpMsg) {
	switch {
	case m.Method != "" && len(m.ID) > 0: // a request from agy
		a.onACPRequest(c, k, m)
	case m.Method == "session/update":
		if k.loading.Load() {
			return
		}
		var p struct {
			Update json.RawMessage `json:"update"`
		}
		if json.Unmarshal(m.Params, &p) == nil && p.Update != nil {
			line, _ := json.Marshal(map[string]any{"type": "agy.update", "update": p.Update})
			a.emit("ai:line:"+c.id, string(line))
		}
	case m.Method == "" && len(m.ID) > 0: // a response
		var id int64
		if json.Unmarshal(m.ID, &id) == nil {
			k.pmu.Lock()
			ch := k.pending[id]
			k.pmu.Unlock()
			if ch != nil {
				ch <- m
			}
		}
	}
}

// onACPRequest answers agy. Our own MCP tools are allowed here because the app
// asks the user itself when the tool runs; agy's built-in tools would act on
// this Windows PC, not on the server, so they are refused.
func (a *App) onACPRequest(c *aiChat, k *acpConn, m acpMsg) {
	reply := func(result any) { k.send(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": result}) }
	if m.Method != "session/request_permission" {
		k.send(map[string]any{"jsonrpc": "2.0", "id": m.ID, "error": map[string]any{"code": -32601, "message": "method not supported: " + m.Method}})
		return
	}
	var p struct {
		ToolCall struct {
			Name  string `json:"name"`
			Title string `json:"title"`
		} `json:"toolCall"`
		Options []struct {
			OptionID string `json:"optionId"`
			Kind     string `json:"kind"`
		} `json:"options"`
	}
	json.Unmarshal(m.Params, &p)
	allow := strings.HasPrefix(p.ToolCall.Name, agyMCPPrefix)
	pick := ""
	for _, o := range p.Options {
		if (allow && o.Kind == "allow_once") || (!allow && strings.HasPrefix(o.Kind, "reject")) {
			pick = o.OptionID
			break
		}
	}
	if pick == "" {
		reply(map[string]any{"outcome": map[string]any{"outcome": "cancelled"}})
	} else {
		reply(map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": pick}})
	}
	if !allow {
		line, _ := json.Marshal(map[string]any{"type": "agy.blocked", "title": firstNonEmpty(p.ToolCall.Title, p.ToolCall.Name)})
		a.emit("ai:line:"+c.id, string(line))
	}
}

// openACPSession starts (or, after a restart, reloads) the chat's conversation.
func (a *App) openACPSession(c *aiChat, k *acpConn, resume, chatContext string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if _, err := k.call(ctx, "initialize", map[string]any{
		"protocolVersion":    1,
		"clientCapabilities": map[string]any{"fs": map[string]any{"readTextFile": false, "writeTextFile": false}, "terminal": false},
	}); err != nil {
		return err
	}
	params := map[string]any{
		"cwd": aiWorkDir(),
		"mcpServers": []any{map[string]any{"type": "http", "name": "rt", "url": a.mcpURL(c.id),
			"headers": []any{map[string]string{"name": "Authorization", "value": "Bearer " + a.ai.token}}}},
		"_meta": map[string]any{"antigravity": map[string]any{"systemPrompt": map[string]any{"append": aiSystemPrompt(chatContext) +
			"\nUse only the remote-terminal (rt) tools. Your own built-in tools (shell, file, browser) act on the user's local Windows PC, not on the server, and are refused."}}},
	}
	if resume != "" {
		params["sessionId"] = resume
		k.loading.Store(true)
		_, err := k.call(ctx, "session/load", params)
		k.loading.Store(false)
		if err == nil {
			k.session = resume
			return nil
		}
		delete(params, "sessionId") // could not resume: start fresh
	}
	res, err := k.call(ctx, "session/new", params)
	if err != nil {
		return err
	}
	var r struct {
		SessionID string `json:"sessionId"`
	}
	if json.Unmarshal(res, &r) != nil || r.SessionID == "" {
		return errors.New(L("Antigravity tidak membuat sesi", "Antigravity did not create a session"))
	}
	k.session = r.SessionID
	return nil
}

// runAntigravity sends one message; the reply streams as ai:line events.
func (a *App) runAntigravity(c *aiChat, text string) error {
	a.ai.mu.Lock()
	if c.running {
		a.ai.mu.Unlock()
		return errors.New(L("Antigravity masih bekerja; tunggu atau tekan Stop", "Antigravity is still working; wait or press Stop"))
	}
	k, session, model, chatContext := c.acp, c.session, c.model, c.context
	c.running = true // reserve the chat while connecting
	a.ai.mu.Unlock()
	fail := func(err error) error {
		a.ai.mu.Lock()
		c.running = false
		a.ai.mu.Unlock()
		return err
	}
	if k != nil && k.context != chatContext {
		// The system prompt is fixed per session: reopen it with the new one.
		a.ai.mu.Lock()
		if c.acp == k {
			c.acp, c.cmd = nil, nil
		}
		a.ai.mu.Unlock()
		k.kill()
		k = nil
	}
	if k == nil {
		var err error
		if k, err = a.startACP(c); err != nil {
			return fail(err)
		}
		if err := a.openACPSession(c, k, session, chatContext); err != nil {
			k.kill()
			return fail(err)
		}
		k.context = chatContext
		a.ai.mu.Lock()
		c.acp, c.cmd, c.session = k, k.cmd, k.session
		a.ai.mu.Unlock()
	}
	if model != "" && model != k.model {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		_, err := k.call(ctx, "session/set_model", map[string]any{"sessionId": k.session, "modelId": model})
		cancel()
		if err != nil {
			return fail(fmt.Errorf(L("model %q tidak bisa dipakai: %w", "model %q cannot be used: %w"), model, err))
		}
		k.model = model
	}
	a.emit("ai:state:"+c.id, map[string]any{"running": true})
	go func() {
		res, err := k.call(context.Background(), "session/prompt", map[string]any{
			"sessionId": k.session, "prompt": []any{map[string]string{"type": "text", "text": text}}})
		a.ai.mu.Lock()
		ours := c.acp == k
		if ours {
			c.running = false
		}
		a.ai.mu.Unlock()
		if !ours {
			return // stopped or reset meanwhile; already reported
		}
		if err == nil {
			line, _ := json.Marshal(map[string]any{"type": "agy.done", "result": res})
			a.emit("ai:line:"+c.id, string(line))
		}
		msg := ""
		if err != nil {
			msg = err.Error()
		}
		a.emit("ai:state:"+c.id, map[string]any{"running": false, "error": msg})
	}()
	return nil
}

// cancelAntigravity interrupts the current turn but keeps the conversation.
func (a *App) cancelAntigravity(c *aiChat) bool {
	a.ai.mu.Lock()
	k := c.acp
	a.ai.mu.Unlock()
	if k == nil {
		return false
	}
	k.send(map[string]any{"jsonrpc": "2.0", "method": "session/cancel", "params": map[string]any{"sessionId": k.session}})
	return true
}
