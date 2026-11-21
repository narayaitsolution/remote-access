package main

import "testing"

func TestMigrateKeys(t *testing.T) {
	s := Settings{Keys: map[string]string{
		"split_vertical":   "Ctrl+Shift+E", // old default -> moves
		"split_horizontal": "Ctrl+Alt+H",   // user's own -> kept
		"close_pane":       "Ctrl+Shift+W", // old default -> moves
	}}
	migrateKeys(&s)
	if s.Keys["split_vertical"] != "Ctrl+Shift+W" || s.Keys["close_pane"] != "Ctrl+Shift+Q" || s.Keys["split_horizontal"] != "Ctrl+Alt+H" {
		t.Fatalf("migrated keys = %v", s.Keys)
	}
	if s.KeysVersion != keysVersion {
		t.Fatalf("KeysVersion = %d", s.KeysVersion)
	}
	// Runs once: a later deliberate Ctrl+Shift+E for split_vertical stays.
	s.Keys["split_vertical"] = "Ctrl+Shift+E"
	migrateKeys(&s)
	if s.Keys["split_vertical"] != "Ctrl+Shift+E" {
		t.Fatalf("second migration changed a user key: %v", s.Keys)
	}
}
