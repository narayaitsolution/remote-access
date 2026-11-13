package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Fake OpenAI-compatible server: lists models, asks for read_screen once,
// then answers with what the tool returned.
func TestOpenAICompatibleProvider(t *testing.T) {
	var mu sync.Mutex
	var gotAuth string
	var requests [][]map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gotAuth = r.Header.Get("Authorization")
		mu.Unlock()
		switch r.URL.Path {
		case "/v1/models":
			io.WriteString(w, `{"data":[{"id":"zeta-model"},{"id":"alpha-model"}]}`)
		case "/v1/chat/completions":
			var body struct {
				Model    string           `json:"model"`
				Messages []map[string]any `json:"messages"`
				Tools    []map[string]any `json:"tools"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			requests = append(requests, body.Messages)
			n := len(requests)
			mu.Unlock()
			if len(body.Tools) == 0 {
				t.Error("tools not sent")
			}
			if n == 1 {
				io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"Saya baca layar dulu.","tool_calls":[{"id":"call_1","type":"function","function":{"name":"read_screen","arguments":"{}"}}]}}],"usage":{"prompt_tokens":100,"completion_tokens":10}}`)
				return
			}
			last := body.Messages[len(body.Messages)-1]
			io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"Di layar: `+strings.ReplaceAll(last["content"].(string), "\n", " ")+`"}}],"usage":{"prompt_tokens":150,"completion_tokens":20}}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	a := NewApp()
	dir := t.TempDir()
	a.dir, a.cfgPath, a.cfg = dir, filepath.Join(dir, configFileName), defaultConfig()

	models, err := a.TestAIProvider(AIProviderInput{BaseURL: srv.URL + "/v1/", APIKey: "sk-test"})
	if err != nil || len(models) != 2 || models[0] != "alpha-model" {
		t.Fatalf("models = %v, %v", models, err)
	}
	pv, err := a.SaveAIProvider(AIProviderInput{Name: "Fake", BaseURL: srv.URL + "/v1/chat/completions", APIKey: "sk-test"})
	if err != nil || pv.BaseURL != srv.URL+"/v1" || !pv.HasKey {
		t.Fatalf("save = %+v, %v", pv, err)
	}
	var found *AIProviderInfo
	for _, p := range a.AIProviders() {
		if p.ID == oaPrefix+pv.ID {
			p := p
			found = &p
		}
	}
	if found == nil || len(found.Models) != 2 || found.Kind != "openai" {
		t.Fatalf("provider not listed with models: %+v", found)
	}

	var lines []string
	tools := 0
	done := make(chan struct{}, 1)
	a.emitHook = func(name string, data any) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case name == "ai:tool":
			tools++
			go a.AIToolResult(data.(map[string]any)["reqId"].(string), false, "MAGIC-4242")
		case strings.HasPrefix(name, "ai:line:"):
			lines = append(lines, data.(string))
		case strings.HasPrefix(name, "ai:state:"):
			if m := data.(map[string]any); m["running"] == false {
				done <- struct{}{}
			}
		}
	}
	if err := a.AISend("c1", oaPrefix+pv.ID, "alpha-model", "apa di layar?", "ctx"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("timeout")
	}
	mu.Lock()
	defer mu.Unlock()
	all := strings.Join(lines, "\n")
	if tools != 1 || !strings.Contains(all, "MAGIC-4242") || !strings.Contains(all, `"oa.done"`) || !strings.Contains(all, `"prompt_tokens":150`) {
		t.Fatalf("tools=%d lines:\n%s", tools, all)
	}
	if gotAuth != "Bearer sk-test" {
		t.Fatalf("auth header = %q", gotAuth)
	}
	// system prompt + user, then + assistant(tool_calls) + tool result
	if len(requests) != 2 || requests[0][0]["role"] != "system" || requests[1][3]["role"] != "tool" {
		t.Fatalf("unexpected conversation: %v", requests)
	}
}
