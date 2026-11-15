package main

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestCleanCompletion(t *testing.T) {
	cases := []struct{ in, prefix, suffix, want string }{
		{"print(x)\n", "def f(x):\n    ", "", "print(x)"},
		{"```python\nreturn x + 1\n```", "def f(x):\n    ", "", "return x + 1"},
		{"    total = a + b", "    total = ", "\n", "a + b"},
		{"len(items))", "n = ", ")\n", "len(items)"},
		{"foo<CURSOR>bar", "", "", "foobar"},
		{"", "x", "", ""},
		{"    if n < 2:\n        return n", "def f(n):\n    ", "", "if n < 2:\n        return n"},
		{"\treturn 1", "func f() int {\n\t", "\n}", "return 1"},
		{"    x = 1", "", "", "    x = 1"},
	}
	for _, c := range cases {
		if got := cleanCompletion(c.in, c.prefix, c.suffix); got != c.want {
			t.Errorf("cleanCompletion(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// Live test: RT_AI_TEST=claude (or codex) go test -run TestCompanionLive -v .
func TestCompanionLive(t *testing.T) {
	prov := os.Getenv("RT_AI_TEST")
	if prov == "" {
		t.Skip("set RT_AI_TEST=claude or codex")
	}
	a := &App{}
	start := time.Now()
	out, err := a.AIComplete(CompletionRequest{ID: "t1", Provider: prov, Path: "/srv/app/util.py", Language: "python",
		Prefix: "def fibonacci(n):\n    \"\"\"Return the n-th Fibonacci number.\"\"\"\n    ", Suffix: "\n\nprint(fibonacci(10))\n"})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("%s in %v: %q", prov, time.Since(start), out)
	if strings.TrimSpace(out) == "" || strings.Contains(out, "```") || strings.Contains(out, "def fibonacci") {
		t.Errorf("unexpected completion %q", out)
	}
}

func TestCompanionPromptBudget(t *testing.T) {
	var head strings.Builder
	head.WriteString("import os\nfrom typing import List\n\n\n\n")
	for i := 0; i < 200; i++ {
		fmt.Fprintf(&head, "def helper_%d(x: int) -> int:\n    y = x * %d   \n    return y\n\n", i, i)
	}
	head.WriteString("class Store:\n    def save(self, item):\n        ")
	var tail strings.Builder
	tail.WriteString("\n\n")
	for i := 0; i < 100; i++ {
		fmt.Fprintf(&tail, "def later_%d():\n    pass\n\n", i)
	}
	full := len(head.String()) + len(tail.String())
	p := companionPrompt(CompletionRequest{Path: "/app/store.py", Language: "python", Prefix: head.String(), Suffix: tail.String()})
	t.Logf("file %d chars -> prompt %d chars", full, len(p))
	if os.Getenv("RT_SHOW_PROMPT") != "" {
		t.Log(p)
	}
	if len(p) > ctxBefore+ctxAfter+ctxImports+ctxOutline+300 {
		t.Errorf("prompt too long: %d", len(p))
	}
	for _, want := range []string{"import os", "from typing import List", "def helper_140(x: int) -> int: …", "def later_45(): …", "def helper_199(x: int) -> int:\n    y = x * 199\n", "class Store:\n    def save(self, item):\n        <CURSOR>"} {
		if !strings.Contains(p, want) {
			t.Errorf("prompt lacks %q", want)
		}
	}
	if strings.Contains(p, "   \n") || strings.Contains(p, "\n\n\n") {
		t.Error("trailing spaces or blank-line runs were not compacted")
	}
}

func TestCompanionPromptSmallFile(t *testing.T) {
	p := companionPrompt(CompletionRequest{Path: "/a.go", Language: "go", Prefix: "package main\n\nfunc main() {\n\t", Suffix: "\n}\n"})
	want := "File: /a.go (go)\nCode:\npackage main\n\nfunc main() {\n\t<CURSOR>\n}\n"
	if p != want {
		t.Errorf("got %q\nwant %q", p, want)
	}
}
