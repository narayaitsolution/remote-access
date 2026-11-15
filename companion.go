package main

// AI Companion: Copilot-style inline code suggestions for the built-in editor.
// The editor sends the text around the cursor; one AI request returns the code
// to insert there. Requests are cancelled as soon as the user keeps typing.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// CompletionRequest is what the editor sends for one suggestion.
type CompletionRequest struct {
	ID       string `json:"id"` // used to cancel
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Path     string `json:"path"`
	Language string `json:"language"`
	Prefix   string `json:"prefix"` // text before the cursor
	Suffix   string `json:"suffix"` // text after the cursor
}

var companion = struct {
	sync.Mutex
	cancel map[string]context.CancelFunc
}{cancel: map[string]context.CancelFunc{}}

const companionSystemPrompt = `You are a code completion engine inside a code editor, like GitHub Copilot.
You receive a file with the marker <CURSOR> where the user's cursor is.
Reply with ONLY the text to insert at <CURSOR>: no explanation, no markdown fences, no repetition of the code before or after the cursor.
Continue the current line and, when it is natural, the next few lines (at most about 15). Match the file's indentation and style.
If nothing useful should be inserted, reply with an empty message.`

// companionPrompt builds the user message, keeping the request small.
func companionPrompt(r CompletionRequest) string {
	prefix, suffix := r.Prefix, r.Suffix
	if len(prefix) > 6000 {
		prefix = prefix[len(prefix)-6000:]
	}
	if len(suffix) > 2000 {
		suffix = suffix[:2000]
	}
	return fmt.Sprintf("File: %s (language: %s)\n\n%s<CURSOR>%s", r.Path, r.Language, prefix, suffix)
}

// AIComplete returns the code to insert at the cursor ("" for no suggestion).
func (a *App) AIComplete(r CompletionRequest) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	companion.Lock()
	companion.cancel[r.ID] = cancel
	companion.Unlock()
	defer func() {
		companion.Lock()
		delete(companion.cancel, r.ID)
		companion.Unlock()
		cancel()
	}()
	prompt := companionPrompt(r)
	var out string
	var err error
	switch {
	case strings.HasPrefix(r.Provider, oaPrefix):
		out, err = a.completeOpenAI(ctx, strings.TrimPrefix(r.Provider, oaPrefix), r.Model, prompt)
	case r.Provider == "claude":
		out, err = completeClaude(ctx, r.Model, prompt)
	case r.Provider == "codex":
		out, err = completeCodex(ctx, r.Model, prompt)
	default:
		return "", errors.New("provider tidak dikenal")
	}
	if ctx.Err() == context.Canceled {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return cleanCompletion(out, r.Prefix, r.Suffix), nil
}

// AICancelComplete stops a running suggestion request.
func (a *App) AICancelComplete(id string) {
	companion.Lock()
	if c := companion.cancel[id]; c != nil {
		c()
	}
	companion.Unlock()
}

// cleanCompletion strips markdown fences and text the model repeated from
// around the cursor.
func cleanCompletion(s, prefix, suffix string) string {
	s = strings.TrimRight(s, " \t\r\n")
	if strings.HasPrefix(strings.TrimSpace(s), "```") {
		t := strings.TrimSpace(s)
		if i := strings.IndexByte(t, '\n'); i >= 0 {
			t = t[i+1:]
		} else {
			t = ""
		}
		t = strings.TrimSuffix(strings.TrimRight(t, " \t\r\n"), "```")
		s = strings.TrimRight(t, " \t\r\n")
	}
	s = strings.ReplaceAll(s, "<CURSOR>", "")
	// The model sometimes repeats the start of the current line.
	line := prefix[strings.LastIndexByte(prefix, '\n')+1:]
	if strings.TrimSpace(line) != "" && strings.HasPrefix(s, line) {
		s = s[len(line):]
	}
	// The cursor already sits after the indentation; models tend to indent again.
	if line != "" && strings.TrimSpace(line) == "" {
		s = strings.TrimLeft(s, " \t")
	}
	// ... or the rest of the current line, which is already there.
	rest := suffix
	if i := strings.IndexByte(rest, '\n'); i >= 0 {
		rest = rest[:i]
	}
	if rest = strings.TrimSpace(rest); rest != "" {
		s = strings.TrimSuffix(s, rest)
	}
	return s
}

func (a *App) completeOpenAI(ctx context.Context, id, model, prompt string) (string, error) {
	p, err := a.aiProviderConfig(id)
	if err != nil {
		return "", err
	}
	key, _ := decryptSecret(p.APIKey)
	if model == "" && len(p.Models) > 0 {
		model = p.Models[0]
	}
	body, _ := json.Marshal(map[string]any{
		"model": model, "temperature": 0.2, "max_tokens": 300,
		"messages": []map[string]string{
			{"role": "system", "content": companionSystemPrompt},
			{"role": "user", "content": prompt},
		},
	})
	req, err := http.NewRequestWithContext(ctx, "POST", p.BaseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	req.Header.Set("HTTP-Referer", "https://github.com/narayaitsolution/remote-access")
	req.Header.Set("X-Title", "Remote Terminal")
	resp, err := oaHTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, snippet(data))
	}
	var r struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(data, &r); err != nil {
		return "", fmt.Errorf("respons tidak dikenali: %s", snippet(data))
	}
	if r.Error != nil {
		return "", errors.New(r.Error.Message)
	}
	if len(r.Choices) == 0 {
		return "", nil
	}
	return r.Choices[0].Message.Content, nil
}

// completeClaude runs one non-interactive Claude Code request without tools.
func completeClaude(ctx context.Context, model, prompt string) (string, error) {
	path, err := exec.LookPath("claude")
	if err != nil {
		return "", errors.New("Claude Code (claude) tidak ditemukan di PATH")
	}
	if model == "" {
		model = "haiku"
	}
	args := []string{"-p", "--output-format", "text", "--tools", "", "--strict-mcp-config",
		"--setting-sources", "", "--system-prompt", companionSystemPrompt, "--model", model}
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Dir = aiWorkDir()
	cmd.Stdin = strings.NewReader(prompt)
	hideWindow(cmd)
	return runCompletionCmd(cmd)
}

// completeCodex runs one read-only `codex exec` and reads its final message.
func completeCodex(ctx context.Context, model, prompt string) (string, error) {
	path, extraEnv, native, err := codexBinary()
	if err != nil {
		return "", err
	}
	f, err := os.CreateTemp("", "rt-companion-*.txt")
	if err != nil {
		return "", err
	}
	outFile := f.Name()
	f.Close()
	defer os.Remove(outFile)
	args := []string{"exec", "--skip-git-repo-check", "-c", `sandbox_mode="read-only"`, "--output-last-message", outFile}
	if native {
		q, _ := json.Marshal(companionSystemPrompt)
		args = append(args, "-c", "developer_instructions="+string(q))
	} else {
		prompt = "<instructions>\n" + companionSystemPrompt + "\n</instructions>\n\n" + prompt
	}
	if model != "" {
		args = append(args, "-m", model)
	}
	args = append(args, "-")
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Dir = aiWorkDir()
	cmd.Env = append(os.Environ(), extraEnv...)
	cmd.Stdin = strings.NewReader(prompt)
	hideWindow(cmd)
	if _, err := runCompletionCmd(cmd); err != nil {
		return "", err
	}
	data, err := os.ReadFile(filepath.Clean(outFile))
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func runCompletionCmd(cmd *exec.Cmd) (string, error) {
	var stdout, stderr strings.Builder
	cmd.Stdout = &limitedWriter{w: &stdout, n: 1 << 20}
	cmd.Stderr = &limitedWriter{w: &stderr, n: 4000}
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("%s: %s", filepath.Base(cmd.Path), msg)
	}
	return stdout.String(), nil
}
