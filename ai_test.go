package main

// Live tests against the real AI CLIs (they use the logged-in account and a
// little quota). Run with:  RT_AI_TEST=claude go test -run TestAILive -v
// or RT_AI_TEST=codex.

import (
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestAILive(t *testing.T) {
	provider := os.Getenv("RT_AI_TEST")
	if provider == "" {
		t.Skip("set RT_AI_TEST=claude or RT_AI_TEST=codex to run")
	}
	model := map[string]string{"claude": "haiku"}[provider]
	a := NewApp()
	var mu sync.Mutex
	var lines []string
	toolCalls := 0
	done := make(chan struct{}, 1)
	a.emitHook = func(name string, data any) {
		switch {
		case name == "ai:tool":
			m := data.(map[string]any)
			mu.Lock()
			toolCalls++
			mu.Unlock()
			t.Logf("tool call: %s %s", m["name"], m["args"])
			go a.AIToolResult(m["reqId"].(string), false, "user@server:~$ echo MAGIC-7731\nMAGIC-7731")
		case strings.HasPrefix(name, "ai:line:"):
			mu.Lock()
			lines = append(lines, data.(string))
			mu.Unlock()
		case strings.HasPrefix(name, "ai:state:"):
			m := data.(map[string]any)
			if m["running"] == false {
				t.Logf("state: %v", m)
				done <- struct{}{}
			}
		}
	}
	err := a.AISend("chat1", provider, model,
		"Use the read_screen tool exactly once, then reply with only the MAGIC number you see on the screen.",
		"Server: test (user@10.0.0.1)")
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.After(4 * time.Minute)
	for {
		mu.Lock()
		all := strings.Join(lines, "\n")
		mu.Unlock()
		finished := strings.Contains(all, `"type":"result"`) || strings.Contains(all, `"turn.completed"`)
		if finished {
			mu.Lock()
			calls := toolCalls
			mu.Unlock()
			if calls == 0 {
				t.Fatalf("AI never called the tool. Output:\n%s", all)
			}
			if !strings.Contains(all, "7731") {
				t.Fatalf("answer missing MAGIC number. Output:\n%s", all)
			}
			a.shutdownAI()
			return
		}
		select {
		case <-done:
			mu.Lock()
			all = strings.Join(lines, "\n")
			mu.Unlock()
			if !strings.Contains(all, `"type":"result"`) && !strings.Contains(all, `"turn.completed"`) {
				t.Fatalf("CLI exited early. Output:\n%s", all)
			}
		case <-deadline:
			t.Fatalf("timeout. Output:\n%s", all)
		case <-time.After(300 * time.Millisecond):
		}
	}
}

// A plain question must be answered as chat, without touching the server.
func TestAIChatNoTools(t *testing.T) {
	provider := os.Getenv("RT_AI_TEST")
	if provider == "" {
		t.Skip("set RT_AI_TEST=claude or RT_AI_TEST=codex to run")
	}
	model := map[string]string{"claude": "haiku"}[provider]
	a := NewApp()
	var mu sync.Mutex
	var lines []string
	tools := 0
	a.emitHook = func(name string, data any) {
		mu.Lock()
		defer mu.Unlock()
		if name == "ai:tool" {
			tools++
			go a.AIToolResult(data.(map[string]any)["reqId"].(string), true, "denied")
		} else if strings.HasPrefix(name, "ai:line:") {
			lines = append(lines, data.(string))
		}
	}
	if err := a.AISend("chat2", provider, model, "Apa kepanjangan dari SSH? Jawab singkat dalam satu kalimat.",
		"The user's terminal is an SSH session to server \"test\" (u@10.0.0.1:22)."); err != nil {
		t.Fatal(err)
	}
	defer a.shutdownAI()
	deadline := time.Now().Add(3 * time.Minute)
	for time.Now().Before(deadline) {
		mu.Lock()
		all := strings.Join(lines, "\n")
		n := tools
		mu.Unlock()
		if strings.Contains(all, `"type":"result"`) || strings.Contains(all, `"turn.completed"`) {
			if n != 0 {
				t.Fatalf("plain chat question triggered %d tool call(s)", n)
			}
			if !strings.Contains(all, "Secure Shell") {
				t.Fatalf("unexpected answer:\n%s", all)
			}
			return
		}
		time.Sleep(300 * time.Millisecond)
	}
	t.Fatal("timeout")
}
