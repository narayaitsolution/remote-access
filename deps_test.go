package main

import "testing"

// Logs what the environment check sees on this machine.
func TestCheckDepsRuns(t *testing.T) {
	deps := NewApp().CheckDeps()
	if len(deps) < 4 {
		t.Fatalf("too few entries: %+v", deps)
	}
	for _, d := range deps {
		t.Logf("%-8s %-8s installable=%v %s", d.ID, d.Status, d.Installable, d.Detail)
	}
	for _, ext := range []string{".docx", ".xlsx", ".pptx", ".pdf", ".txt"} {
		t.Logf("app for %s: %q", ext, associatedApp(ext))
	}
}
