package main

// Live test of agent mode against a simulated server (uses a little quota):
//   RT_AI_TEST=claude go test -run TestAIAgentMode -v .

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestAIAgentMode(t *testing.T) {
	provider := os.Getenv("RT_AI_TEST")
	if provider == "" {
		t.Skip("set RT_AI_TEST=claude or RT_AI_TEST=codex to run")
	}
	model := map[string]string{"claude": "sonnet"}[provider]
	const path = "/var/www/app/hello.php"
	file := "<?php\nfunction greet($name) {\n    echo \"Hello \" . $name\n}\n\ngreet(\"World\");\n"
	work := "T1"
	a := NewApp()
	var mu sync.Mutex
	var lines, used []string
	checkedAfterEdit := false
	edited := false
	numbered := func() string {
		var b strings.Builder
		for i, l := range strings.Split(strings.TrimSuffix(file, "\n"), "\n") {
			fmt.Fprintf(&b, "%d| %s\n", i+1, l)
		}
		return b.String()
	}
	a.emitHook = func(name string, data any) {
		switch {
		case name == "ai:tool":
			m := data.(map[string]any)
			tool := m["name"].(string)
			var args map[string]any
			switch v := m["args"].(type) {
			case json.RawMessage:
				json.Unmarshal(v, &args)
			case map[string]any:
				args = v
			}
			mu.Lock()
			used = append(used, tool)
			res, isErr := "", false
			switch tool {
			case "read_screen", "wait_for_screen":
				if work == "T1" {
					res = "[foreground program: opencode]\nopencode v1.0 — ask anything\n> "
				} else {
					res = "dev@web:/var/www/app$ "
				}
			case "open_terminal":
				work = "T2"
				res = "Opened T2 in a new tab; it is now your working terminal.\nScreen of T2:\ndev@web:/var/www/app$ "
			case "use_terminal":
				work = fmt.Sprint(args["terminal"])
				res = "Working terminal is now " + work
			case "run_command", "run_background":
				cmd := fmt.Sprint(args["command"])
				switch {
				case tool == "run_command" && work == "T1":
					res, isErr = `"opencode" is running in the foreground of the terminal, not the shell prompt, so the command was NOT typed. Call open_terminal.`, true
				case strings.Contains(cmd, "php -l") || strings.Contains(cmd, "php -f") || strings.Contains(cmd, "php "+path) || strings.Contains(cmd, "php hello.php"):
					if strings.Contains(file, "$name;") {
						res = "No syntax errors detected in " + path + "\nexit code: 0"
						if edited {
							checkedAfterEdit = true
						}
					} else {
						res = "PHP Parse error:  syntax error, unexpected token \"}\", expecting \",\" or \";\" in " + path + " on line 4\nexit code: 255"
					}
				case strings.Contains(cmd, "find") || strings.Contains(cmd, "ls") || strings.Contains(cmd, "grep"):
					res = path + "\nexit code: 0"
				default:
					res = "exit code: 0"
				}
			case "open_file":
				res = "Opened " + path + " in an editor tab. Content (line numbers are not part of the file):\n" + numbered()
			case "read_file":
				res = file
			case "edit_file":
				next := file
				ok := true
				edits, _ := args["edits"].([]any)
				for _, e := range edits {
					em := e.(map[string]any)
					old, nw := fmt.Sprint(em["old_text"]), fmt.Sprint(em["new_text"])
					if strings.Count(next, old) != 1 {
						ok = false
						break
					}
					next = strings.Replace(next, old, nw, 1)
				}
				if ok && len(edits) > 0 {
					file, edited = next, true
					res = "Edited and saved " + path + ". Now verify the change."
				} else {
					res, isErr = "old_text was not found exactly once; nothing was changed", true
				}
			case "write_file":
				file, edited = fmt.Sprint(args["content"]), true
				res = "Wrote file"
			case "list_dir":
				res = "/var/www/app\n- hello.php"
			default:
				res, isErr = "not available in this test", true
			}
			mu.Unlock()
			go a.AIToolResult(m["reqId"].(string), isErr, res)
		case strings.HasPrefix(name, "ai:line:"):
			mu.Lock()
			lines = append(lines, data.(string))
			mu.Unlock()
		}
	}
	msg := "[AGENT MODE]\n[Working terminal T1: tmux session \"main\", foreground program: opencode, directory: /var/www/app]\n" +
		"Perbaiki syntax error di hello.php (folder /var/www/app) dan pastikan sudah tidak error."
	if err := a.AISend("agent1", provider, model, msg, "The user's terminal is an SSH session to server \"web\" (dev@10.0.0.1:22)."); err != nil {
		t.Fatal(err)
	}
	defer a.shutdownAI()
	deadline := time.Now().Add(8 * time.Minute)
	for time.Now().Before(deadline) {
		mu.Lock()
		all := strings.Join(lines, "\n")
		tools := append([]string(nil), used...)
		final, fixed, verified := file, strings.Contains(file, "$name;"), checkedAfterEdit
		mu.Unlock()
		if strings.Contains(all, `"type":"result"`) || strings.Contains(all, `"turn.completed"`) {
			t.Logf("tools used: %v", tools)
			for _, u := range tools {
				if u == "send_keys" {
					t.Errorf("AI typed into opencode for a small task: %v", tools)
				}
			}
			if !fixed {
				t.Errorf("file not fixed:\n%s", final)
			}
			if !verified {
				t.Errorf("no syntax check after the edit; tools: %v", tools)
			}
			if !contains(tools, "edit_file") {
				t.Errorf("expected a visible edit_file, tools: %v", tools)
			}
			if !contains(tools, "open_terminal") {
				t.Errorf("expected open_terminal (opencode was busy on T1), tools: %v", tools)
			}
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatal("timeout")
}
