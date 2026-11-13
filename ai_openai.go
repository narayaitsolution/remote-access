package main

// OpenAI-compatible providers (base URL + API key). The app itself runs the
// agent loop: chat/completions with function calling, where each function is
// one of the remote-terminal tools and goes through the same UI approval flow.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

const oaPrefix = "oa:"

type AIProviderInput struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	BaseURL string `json:"baseUrl"`
	APIKey  string `json:"apiKey"`
	KeepKey bool   `json:"keepKey"` // editing: keep the stored key
	Models  string `json:"models"`  // optional, comma separated
}

type AIProviderView struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	BaseURL string   `json:"baseUrl"`
	HasKey  bool     `json:"hasKey"`
	Models  []string `json:"models"`
}

var oaHTTP = &http.Client{Timeout: 5 * time.Minute}

// model lists fetched from /models, cached per provider
var oaModelCache = struct {
	sync.Mutex
	m map[string][]string
}{m: map[string][]string{}}

func (a *App) aiProviderConfig(id string) (AIProviderConfig, error) {
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	for _, p := range a.cfg.AIProviders {
		if p.ID == id {
			return p, nil
		}
	}
	return AIProviderConfig{}, errors.New("provider AI tidak ditemukan")
}

// ListAIProviders returns the configured OpenAI-compatible providers (without keys).
func (a *App) ListAIProviders() []AIProviderView {
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	out := []AIProviderView{}
	for _, p := range a.cfg.AIProviders {
		out = append(out, AIProviderView{ID: p.ID, Name: p.Name, BaseURL: p.BaseURL, HasKey: p.APIKey != "", Models: p.Models})
	}
	return out
}

func parseModelList(s string) []string {
	var out []string
	for _, m := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == '\n' }) {
		if m = strings.TrimSpace(m); m != "" {
			out = append(out, m)
		}
	}
	return out
}

func normalizeBaseURL(u string) string {
	u = strings.TrimRight(strings.TrimSpace(u), "/")
	u = strings.TrimSuffix(u, "/chat/completions")
	return u
}

// SaveAIProvider adds or updates an OpenAI-compatible provider.
func (a *App) SaveAIProvider(in AIProviderInput) (AIProviderView, error) {
	in.Name, in.BaseURL = strings.TrimSpace(in.Name), normalizeBaseURL(in.BaseURL)
	if in.BaseURL == "" || !(strings.HasPrefix(in.BaseURL, "http://") || strings.HasPrefix(in.BaseURL, "https://")) {
		return AIProviderView{}, errors.New("URL harus diawali http:// atau https://")
	}
	if in.Name == "" {
		in.Name = in.BaseURL
	}
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	p := AIProviderConfig{ID: in.ID, Name: in.Name, BaseURL: in.BaseURL, Models: parseModelList(in.Models)}
	idx := -1
	for i := range a.cfg.AIProviders {
		if in.ID != "" && a.cfg.AIProviders[i].ID == in.ID {
			idx = i
		}
	}
	if idx >= 0 && in.KeepKey {
		p.APIKey = a.cfg.AIProviders[idx].APIKey
	} else if in.APIKey != "" {
		enc, err := encryptSecret(in.APIKey)
		if err != nil {
			return AIProviderView{}, err
		}
		p.APIKey = enc
	}
	if idx >= 0 {
		a.cfg.AIProviders[idx] = p
	} else {
		p.ID = newID()
		a.cfg.AIProviders = append(a.cfg.AIProviders, p)
	}
	oaModelCache.Lock()
	delete(oaModelCache.m, p.ID)
	oaModelCache.Unlock()
	return AIProviderView{ID: p.ID, Name: p.Name, BaseURL: p.BaseURL, HasKey: p.APIKey != "", Models: p.Models}, saveConfig(a.cfgPath, a.cfg)
}

func (a *App) DeleteAIProvider(id string) error {
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	out := a.cfg.AIProviders[:0]
	for _, p := range a.cfg.AIProviders {
		if p.ID != id {
			out = append(out, p)
		}
	}
	a.cfg.AIProviders = out
	return saveConfig(a.cfgPath, a.cfg)
}

// TestAIProvider checks URL + key by listing models; it works for unsaved input too.
func (a *App) TestAIProvider(in AIProviderInput) ([]string, error) {
	key := in.APIKey
	if in.KeepKey && in.ID != "" {
		if p, err := a.aiProviderConfig(in.ID); err == nil {
			key, _ = decryptSecret(p.APIKey)
		}
	}
	return fetchModels(normalizeBaseURL(in.BaseURL), key)
}

func fetchModels(base, key string) ([]string, error) {
	req, err := http.NewRequest("GET", base+"/models", nil)
	if err != nil {
		return nil, err
	}
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	c := &http.Client{Timeout: 10 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, snippet(body))
	}
	var r struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
		Models []struct { // Ollama-style
			Name string `json:"name"`
		} `json:"models"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, fmt.Errorf("respons /models tidak dikenali: %s", snippet(body))
	}
	var out []string
	for _, m := range r.Data {
		out = append(out, m.ID)
	}
	for _, m := range r.Models {
		out = append(out, m.Name)
	}
	sort.Strings(out)
	return out, nil
}

func snippet(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	return s
}

// openAIProviderInfos lists configured providers for the AI panel, with models.
func (a *App) openAIProviderInfos() []AIProviderInfo {
	a.cfgMu.Lock()
	provs := append([]AIProviderConfig(nil), a.cfg.AIProviders...)
	a.cfgMu.Unlock()
	out := make([]AIProviderInfo, len(provs))
	var wg sync.WaitGroup
	for i, p := range provs {
		wg.Add(1)
		go func(i int, p AIProviderConfig) {
			defer wg.Done()
			models := p.Models
			if len(models) == 0 {
				oaModelCache.Lock()
				cached, ok := oaModelCache.m[p.ID]
				oaModelCache.Unlock()
				if ok {
					models = cached
				} else {
					key, _ := decryptSecret(p.APIKey)
					if m, err := fetchModels(p.BaseURL, key); err == nil {
						models = m
						oaModelCache.Lock()
						oaModelCache.m[p.ID] = m
						oaModelCache.Unlock()
					}
				}
			}
			def := ""
			if len(models) > 0 {
				def = models[0]
			}
			out[i] = AIProviderInfo{ID: oaPrefix + p.ID, Name: p.Name, Installed: true, Path: p.BaseURL, Models: models, DefaultModel: def, Kind: "openai"}
		}(i, p)
	}
	wg.Wait()
	return out
}

func toolsAsFunctions() []map[string]any {
	out := make([]map[string]any, 0, len(aiTools))
	for _, t := range aiTools {
		out = append(out, map[string]any{"type": "function", "function": map[string]any{
			"name": t.Name, "description": t.Description, "parameters": t.InputSchema,
		}})
	}
	return out
}

// runOpenAI runs one user turn: request → tool calls → request … until the model answers.
func (a *App) runOpenAI(c *aiChat, text string) error {
	p, err := a.aiProviderConfig(strings.TrimPrefix(c.provider, oaPrefix))
	if err != nil {
		return err
	}
	key, err := decryptSecret(p.APIKey)
	if err != nil {
		return err
	}
	a.ai.mu.Lock()
	if c.running {
		a.ai.mu.Unlock()
		return errors.New("AI masih bekerja; tunggu atau tekan Stop")
	}
	if len(c.history) == 0 {
		c.history = []map[string]any{{"role": "system", "content": aiSystemPrompt(c.context)}}
	}
	c.history = append(c.history, map[string]any{"role": "user", "content": text})
	ctx, cancel := context.WithCancel(context.Background())
	c.cancel, c.running = cancel, true
	model := c.model
	a.ai.mu.Unlock()
	a.emit("ai:state:"+c.id, map[string]any{"running": true})

	go func() {
		errMsg := ""
		defer func() {
			a.ai.mu.Lock()
			c.running, c.cancel = false, nil
			a.ai.mu.Unlock()
			cancel()
			a.emit("ai:state:"+c.id, map[string]any{"running": false, "error": errMsg})
		}()
		for step := 0; step < 40; step++ {
			a.ai.mu.Lock()
			msgs := append([]map[string]any(nil), c.history...)
			a.ai.mu.Unlock()
			msg, usage, err := oaChat(ctx, p.BaseURL, key, model, msgs)
			if err != nil {
				if ctx.Err() == nil {
					errMsg = err.Error()
				}
				return
			}
			if usage != nil {
				line, _ := json.Marshal(map[string]any{"type": "oa.usage", "usage": usage})
				a.emit("ai:line:"+c.id, string(line))
			}
			a.ai.mu.Lock()
			c.history = append(c.history, msg)
			a.ai.mu.Unlock()
			if content, _ := msg["content"].(string); strings.TrimSpace(content) != "" {
				line, _ := json.Marshal(map[string]any{"type": "oa.text", "text": content})
				a.emit("ai:line:"+c.id, string(line))
			}
			calls, _ := msg["tool_calls"].([]any)
			if len(calls) == 0 {
				a.emit("ai:line:"+c.id, `{"type":"oa.done"}`)
				return
			}
			for _, raw := range calls {
				call, _ := raw.(map[string]any)
				fn, _ := call["function"].(map[string]any)
				name, _ := fn["name"].(string)
				args, _ := fn["arguments"].(string)
				id, _ := call["id"].(string)
				if strings.TrimSpace(args) == "" {
					args = "{}"
				}
				res := a.callTool(ctx, c.id, name, json.RawMessage(args))
				if ctx.Err() != nil {
					return
				}
				content := res.Text
				if res.IsError {
					content = "ERROR: " + content
				}
				a.ai.mu.Lock()
				c.history = append(c.history, map[string]any{"role": "tool", "tool_call_id": id, "content": content})
				a.ai.mu.Unlock()
			}
		}
		errMsg = "berhenti setelah 40 langkah"
	}()
	return nil
}

// oaChat sends one chat/completions request and returns the assistant message.
func oaChat(ctx context.Context, base, key, model string, msgs []map[string]any) (map[string]any, map[string]any, error) {
	body, _ := json.Marshal(map[string]any{
		"model": model, "messages": msgs, "tools": toolsAsFunctions(), "tool_choice": "auto",
	})
	req, err := http.NewRequestWithContext(ctx, "POST", base+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	req.Header.Set("HTTP-Referer", "https://github.com/narayaitsolution/remote-access") // OpenRouter attribution
	req.Header.Set("X-Title", "Remote Terminal")
	resp, err := oaHTTP.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if resp.StatusCode != 200 {
		return nil, nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, snippet(data))
	}
	var r struct {
		Choices []struct {
			Message map[string]any `json:"message"`
		} `json:"choices"`
		Usage map[string]any `json:"usage"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, nil, fmt.Errorf("respons tidak dikenali: %s", snippet(data))
	}
	if r.Error != nil {
		return nil, nil, errors.New(r.Error.Message)
	}
	if len(r.Choices) == 0 || r.Choices[0].Message == nil {
		return nil, nil, fmt.Errorf("respons kosong: %s", snippet(data))
	}
	m := r.Choices[0].Message
	out := map[string]any{"role": "assistant", "content": m["content"]}
	if tc, ok := m["tool_calls"].([]any); ok && len(tc) > 0 {
		out["tool_calls"] = tc
	}
	if out["content"] == nil {
		out["content"] = ""
	}
	return out, r.Usage, nil
}
