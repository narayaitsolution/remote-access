package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNewerVersion(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"v11.0", "10.0", true}, {"10.1", "10.0", true}, {"10.0", "10.0", false}, {"9.9", "10.0", false},
		{"v10.10", "10.9", true}, {"10", "9.5", true}, {"10.0.1", "10.0", true}, {"bad", "1.0", false}, {"1.0", "", false},
	}
	for _, c := range cases {
		if got := newerVersion(c.a, c.b); got != c.want {
			t.Errorf("newerVersion(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestEvaluateReleases(t *testing.T) {
	asset := func(v, name string) []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
		Size int64  `json:"size"`
	} {
		return []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
			Size int64  `json:"size"`
		}{{name, updateDLPrefix + "v" + v + "/" + name, 123}}
	}
	rels := []ghRelease{
		{TagName: "v9.0", Body: "old", Assets: asset("9.0", "RemoteTerminal-9.0.exe")},
		{TagName: "v11.0", Body: "Info window.\r\n\r\n**Download:** `RemoteTerminal.exe` below", PublishedAt: "2026-11-17T10:00:00Z", Assets: asset("11.0", "RemoteTerminal.exe")},
		{TagName: "v12.0", Body: "beta", Prerelease: true, Assets: asset("12.0", "RemoteTerminal.exe")},
		{TagName: "v10.0", Body: "Agent mode", Assets: asset("10.0", "RemoteTerminal-10.0.exe")},
		{TagName: "v11.1", Body: "no exe yet"},
	}
	u := evaluateReleases("9.0", rels)
	if !u.Available || u.Latest != "11.0" || u.AssetName != "RemoteTerminal.exe" || u.Size != 123 {
		t.Fatalf("update = %+v", u)
	}
	// 11.1 has no .exe yet (still being built): not offered, notes not shown.
	if len(u.Notes) != 2 || u.Notes[0].Version != "11.0" || u.Notes[1].Version != "10.0" {
		t.Fatalf("notes = %+v", u.Notes)
	}
	if u.Notes[0].Notes != "Info window." || u.Notes[0].Date != "2026-11-17" {
		t.Fatalf("note 11.0 = %+v", u.Notes[0])
	}
	if u := evaluateReleases("11.0", rels); u.Available {
		t.Fatalf("no update expected for 11.0: %+v", u)
	}
}

func TestReleaseNotesAndChangelog(t *testing.T) {
	body := "## Remote Terminal 11.0\r\n\r\n" + notesIDStart + "\n- Fitur A\n- Fitur B\n" + notesIDEnd + "\n\nFeature A, feature B\n\n**Download:** x"
	if got := releaseNotes(body); got != "- Fitur A\n- Fitur B" {
		t.Errorf("Indonesian notes = %q", got)
	}
	if got := releaseNotes("## Remote Terminal 10.0\n\nAgent mode\n\n**Download:** x"); got != "Agent mode" {
		t.Errorf("English notes = %q", got)
	}
	// The running version must have Indonesian notes in CHANGELOG.id.md.
	sec := changelogSection(changelogID, appVersion)
	if sec == "" || strings.Contains(sec, "## ") {
		t.Fatalf("CHANGELOG.id.md has no section for %s: %q", appVersion, sec)
	}
	if changelogSection(changelogID, "1.0") == "" || changelogSection(changelogID, "99.0") != "" {
		t.Error("changelogSection boundaries")
	}
}

// Live: RT_UPDATE_TEST=1 go test -run TestCheckUpdateLive -v .
func TestCheckUpdateLive(t *testing.T) {
	if os.Getenv("RT_UPDATE_TEST") == "" {
		t.Skip("set RT_UPDATE_TEST=1")
	}
	a := NewApp()
	u, err := a.CheckUpdate()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("current %s latest %s available %v asset %s notes %d", u.Current, u.Latest, u.Available, u.AssetURL, len(u.Notes))
	if u.Current != appVersion {
		t.Fatalf("current = %q", u.Current)
	}
	// As if this were an old version: the real releases must offer an update.
	rels, err := fetchReleases()
	if err != nil {
		t.Fatal(err)
	}
	old := evaluateReleases("8.0", rels)
	t.Logf("from 8.0: latest %s, asset %s (%d bytes), notes for %d versions; first: %.120s", old.Latest, old.AssetName, old.Size, len(old.Notes), old.Notes[0].Notes)
	if !old.Available || old.AssetURL == "" || len(old.Notes) < 2 || strings.Contains(old.Notes[0].Notes, "**Download:**") {
		t.Fatalf("from 8.0: %+v", old)
	}
}

// Live: RT_UPDATE_TEST=1 go test -run TestDownloadUpdateLive -v .  (downloads ~28 MB into a temp folder)
func TestDownloadUpdateLive(t *testing.T) {
	if os.Getenv("RT_UPDATE_TEST") == "" {
		t.Skip("set RT_UPDATE_TEST=1")
	}
	rels, err := fetchReleases()
	if err != nil {
		t.Fatal(err)
	}
	u := evaluateReleases("8.0", rels)
	dir := t.TempDir()
	updateDir = func() string { return dir }
	defer func() { updateDir = downloadsDir }()
	// A file with the same name that is in use must not block the download.
	busy := filepath.Join(dir, updateExeName)
	os.WriteFile(busy, []byte("old"), 0o644)
	f, _ := os.Open(busy)
	defer f.Close()
	a := NewApp()
	var events int
	a.emitHook = func(name string, _ any) {
		if name == "update:progress" {
			events++
		}
	}
	got, err := a.DownloadUpdate(u.AssetURL)
	if err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(got)
	if err != nil || st.Size() != u.Size {
		t.Fatalf("downloaded %s: %v size %d, want %d", got, err, st.Size(), u.Size)
	}
	t.Logf("saved %s (%d bytes, %d progress events); Downloads folder would be %s", got, st.Size(), events, downloadsDir())
	if _, err := a.DownloadUpdate("https://example.com/evil.exe"); err == nil {
		t.Fatal("foreign URL accepted")
	}
	if left, _ := filepath.Glob(filepath.Join(dir, "*.part")); len(left) > 0 {
		t.Fatalf("temporary files left: %v", left)
	}
}

func TestEnglishNotesAndChangelog(t *testing.T) {
	uiLang.Store("en")
	defer uiLang.Store("id")
	body := "## Remote Terminal 11.1\n\n<!-- notes-id -->\n- Fitur A\n<!-- /notes-id -->\n\nLanguage choice\n\n**Download:** x"
	if got := releaseNotes(body); got != "Language choice" {
		t.Errorf("English notes = %q", got)
	}
	cl := changelogFromReadme(readmeMD)
	if !strings.Contains(cl, "\n## "+appVersion+"\n") || !strings.Contains(cl, "\n## 1.0\n") {
		t.Errorf("README changelog lacks versions:\n%.300s", cl)
	}
}

func TestDonorsFile(t *testing.T) {
	d, ok := parseDonors(donorsEmbedded)
	if !ok || len(d.Links) == 0 {
		t.Fatalf("donors.json invalid or without a link: %+v", d)
	}
	if d, _ := parseDonors([]byte(`{"links":[{"name":"x","url":"javascript:alert(1)"}]}`)); len(d.Links) != 0 || d.Donors == nil {
		t.Errorf("unsafe link kept: %+v", d)
	}
}
