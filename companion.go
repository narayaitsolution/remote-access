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
	"regexp"
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

const companionSystemPrompt = `You are a code completion engine, like GitHub Copilot.
Input: a file outline (imports and declarations from parts of the file not shown) and the code around the cursor, marked <CURSOR>.
Reply with ONLY the text to insert at <CURSOR>: no explanation, no markdown fences, no repeated code.
Complete the current line and, when natural, the next lines (at most ~15). Match indentation and style. Reply empty if nothing fits.`

// Context budget per request (characters, roughly 4 per token): the code
// around the cursor in full, plus an outline of the rest of the file, so the
// model knows the imports, classes and functions without reading them all.
const (
	ctxBefore  = 3000 // code before the cursor
	ctxAfter   = 1000 // code after the cursor
	ctxImports = 600  // import/include lines from the rest of the file
	ctxOutline = 1200 // declaration lines from the rest of the file
)

var (
	reImport = regexp.MustCompile(`^\s*(import\s|from\s+\S+\s+import\s|#\s*include\s|using\s|use\s|require(_once)?[\s(]|include(_once)?[\s(]|package\s|namespace\s|extern\s+crate\s|const\s+\w+\s*=\s*require\()`)
	reDecl   = regexp.MustCompile(`^\s*(export\s+)?(default\s+)?((async\s+)?def\s|class\s|interface\s|trait\s|enum\s|struct\s|impl\b|type\s|func\s|fn\s|pub\s|fun\s|function\s|module\s|object\s|record\s|(public|private|protected|internal|static|abstract|final|override|virtual|async)\s[^=;]*\(|(const|let|var)\s+\w+\s*=\s*(async\s*)?(\([^)]*\)|\w+)\s*=>)`)
)

// companionPrompt builds the user message, keeping the request small.
func companionPrompt(r CompletionRequest) string {
	before, restBefore := r.Prefix, ""
	if len(before) > ctxBefore {
		cut := len(before) - ctxBefore
		if i := strings.IndexByte(before[cut:], '\n'); i >= 0 {
			cut += i + 1 // start at a whole line
		}
		before, restBefore = before[cut:], before[:cut]
	}
	after, restAfter := r.Suffix, ""
	if len(after) > ctxAfter {
		cut := ctxAfter
		if i := strings.LastIndexByte(after[:cut], '\n'); i > 0 {
			cut = i // end at a whole line
		}
		after, restAfter = after[:cut], after[cut:]
	}
	var b strings.Builder
	fmt.Fprintf(&b, "File: %s (%s)\n", r.Path, r.Language)
	if outline := fileOutline(restBefore, restAfter); outline != "" {
		b.WriteString("Outline of the parts not shown:\n")
		b.WriteString(outline)
	}
	b.WriteString("Code:\n")
	b.WriteString(compactCode(before))
	b.WriteString("<CURSOR>")
	b.WriteString(compactCode(after))
	return b.String()
}

// fileOutline lists import lines and declaration lines (signatures only) from
// the parts of the file that are not sent in full. Declarations nearest the
// cursor are kept when the budget runs out.
func fileOutline(before, after string) string {
	var imports, declBefore, declAfter []string
	seen := map[string]bool{}
	scan := func(text string, decls *[]string) {
		for _, line := range strings.Split(text, "\n") {
			line = strings.TrimRight(line, " \t\r")
			t := strings.TrimSpace(line)
			if t == "" || seen[t] {
				continue
			}
			switch {
			case reImport.MatchString(line):
				seen[t] = true
				imports = append(imports, t)
			case reDecl.MatchString(line):
				seen[t] = true
				if len(line) > 160 {
					line = line[:160] + "…"
				}
				*decls = append(*decls, strings.TrimRight(line, "{ ")+" …")
			}
		}
	}
	scan(before, &declBefore)
	scan(after, &declAfter)

	var b strings.Builder
	n := 0
	for _, l := range imports {
		if n+len(l) > ctxImports {
			b.WriteString("…\n")
			break
		}
		b.WriteString(l + "\n")
		n += len(l) + 1
	}
	// Take declarations alternately from just before and just after the window.
	var keepBefore, keepAfter []string
	n = 0
	for i, j := len(declBefore)-1, 0; i >= 0 || j < len(declAfter); i, j = i-1, j+1 {
		if i >= 0 {
			if n+len(declBefore[i]) > ctxOutline {
				break
			}
			keepBefore = append([]string{declBefore[i]}, keepBefore...)
			n += len(declBefore[i]) + 1
		}
		if j < len(declAfter) {
			if n+len(declAfter[j]) > ctxOutline {
				break
			}
			keepAfter = append(keepAfter, declAfter[j])
			n += len(declAfter[j]) + 1
		}
	}
	for _, l := range keepBefore {
		b.WriteString(l + "\n")
	}
	if len(keepBefore)+len(keepAfter) > 0 {
		b.WriteString("  [code around the cursor]\n")
	}
	for _, l := range keepAfter {
		b.WriteString(l + "\n")
	}
	if len(keepBefore)+len(keepAfter) == 0 && b.Len() == 0 {
		return ""
	}
	return b.String()
}

// compactCode drops trailing spaces and squeezes runs of blank lines, which
// costs tokens without adding meaning. Indentation is kept.
func compactCode(s string) string {
	lines := strings.Split(s, "\n")
	out := lines[:0]
	blank := 0
	for i, l := range lines {
		if i < len(lines)-1 { // the last line may end at the cursor: keep it as is
			l = strings.TrimRight(l, " \t\r")
		}
		if strings.TrimSpace(l) == "" && i > 0 && i < len(lines)-1 {
			blank++
			if blank > 1 {
				continue
			}
		} else {
			blank = 0
		}
		out = append(out, l)
	}
	return strings.Join(out, "\n")
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
