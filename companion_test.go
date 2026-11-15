package main

import (
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
