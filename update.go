package main

// Update check against the project's GitHub Releases. The check runs in the
// background at start-up; the UI shows nothing when there is no update or
// GitHub cannot be reached. Updating only downloads the new .exe to the
// Downloads folder: the user replaces the old file themselves, so config.toml
// and known_hosts next to it are never touched.

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	updateRepo     = "narayaitsolution/remote-access"
	updateAPI      = "https://api.github.com/repos/" + updateRepo + "/releases?per_page=30"
	updateDLPrefix = "https://github.com/" + updateRepo + "/releases/download/"
	updateExeName  = "RemoteTerminal.exe"
)

// ReleaseNote is what changed in one newer version.
type ReleaseNote struct {
	Version string `json:"version"`
	Date    string `json:"date"`
	Notes   string `json:"notes"` // Markdown
}

// UpdateInfo is the result of an update check.
type UpdateInfo struct {
	Current   string        `json:"current"`
	Latest    string        `json:"latest"`
	Available bool          `json:"available"`
	Notes     []ReleaseNote `json:"notes"` // newer versions, newest first
	AssetURL  string        `json:"assetUrl"`
	AssetName string        `json:"assetName"`
	Size      int64         `json:"size"`
	PageURL   string        `json:"pageUrl"`
}

type ghRelease struct {
	TagName     string `json:"tag_name"`
	Body        string `json:"body"`
	Draft       bool   `json:"draft"`
	Prerelease  bool   `json:"prerelease"`
	PublishedAt string `json:"published_at"`
	HTMLURL     string `json:"html_url"`
	Assets      []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
		Size int64  `json:"size"`
	} `json:"assets"`
}

var updateHTTP = &http.Client{Timeout: 15 * time.Second}

// parseVersion turns "v10.2" or "10.2" into comparable numbers.
func parseVersion(s string) ([]int, bool) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "v")
	if s == "" {
		return nil, false
	}
	var out []int
	for _, p := range strings.Split(s, ".") {
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil, false
		}
		out = append(out, n)
	}
	return out, true
}

// newerVersion reports whether a is newer than b.
func newerVersion(a, b string) bool {
	va, ok1 := parseVersion(a)
	vb, ok2 := parseVersion(b)
	if !ok1 || !ok2 {
		return false
	}
	for i := 0; i < len(va) || i < len(vb); i++ {
		x, y := 0, 0
		if i < len(va) {
			x = va[i]
		}
		if i < len(vb) {
			y = vb[i]
		}
		if x != y {
			return x > y
		}
	}
	return false
}

//go:embed CHANGELOG.id.md
var changelogID string

// GetChangelog returns the version history in Indonesian (Markdown).
func (a *App) GetChangelog() string { return changelogID }

const notesIDStart, notesIDEnd = "<!-- notes-id -->", "<!-- /notes-id -->"

// releaseNotes keeps the "what changed" part of a release body: the
// Indonesian block the release workflow copies from CHANGELOG.id.md when there
// is one, otherwise the English notes without the title and download hint.
func releaseNotes(body string) string {
	body = strings.ReplaceAll(body, "\r\n", "\n")
	if i := strings.Index(body, notesIDStart); i >= 0 {
		rest := body[i+len(notesIDStart):]
		if j := strings.Index(rest, notesIDEnd); j >= 0 {
			return strings.TrimSpace(rest[:j])
		}
	}
	var keep []string
	for _, l := range strings.Split(body, "\n") {
		t := strings.TrimSpace(l)
		if strings.HasPrefix(t, "**Download:**") {
			break
		}
		if strings.HasPrefix(t, "## Remote Terminal") {
			continue
		}
		keep = append(keep, l)
	}
	return strings.TrimSpace(strings.Join(keep, "\n"))
}

// changelogSection returns the "## <version>" section of CHANGELOG.id.md.
func changelogSection(md, version string) string {
	md = strings.ReplaceAll(md, "\r\n", "\n")
	head := "\n## " + version + "\n"
	i := strings.Index(md, head)
	if i < 0 {
		return ""
	}
	rest := md[i+len(head):]
	if j := strings.Index(rest, "\n## "); j >= 0 {
		rest = rest[:j]
	}
	return strings.TrimSpace(rest)
}

// evaluateReleases picks the versions newer than current from a release list.
func evaluateReleases(current string, rels []ghRelease) UpdateInfo {
	info := UpdateInfo{Current: current, Latest: current}
	sort.SliceStable(rels, func(i, j int) bool { return newerVersion(rels[i].TagName, rels[j].TagName) })
	for _, r := range rels {
		if r.Draft || r.Prerelease || !newerVersion(r.TagName, current) {
			continue
		}
		v := strings.TrimPrefix(r.TagName, "v")
		if !info.Available {
			for _, as := range r.Assets {
				if strings.EqualFold(filepath.Ext(as.Name), ".exe") && strings.HasPrefix(as.URL, updateDLPrefix) {
					info.AssetURL, info.AssetName, info.Size = as.URL, as.Name, as.Size
					break
				}
			}
			if info.AssetURL == "" {
				continue // no executable attached (yet): not offered
			}
			info.Available, info.Latest, info.PageURL = true, v, r.HTMLURL
		}
		date := r.PublishedAt
		if len(date) >= 10 {
			date = date[:10]
		}
		info.Notes = append(info.Notes, ReleaseNote{Version: v, Date: date, Notes: releaseNotes(r.Body)})
	}
	return info
}

// CheckUpdate asks GitHub for newer releases.
func (a *App) CheckUpdate() (UpdateInfo, error) {
	rels, err := fetchReleases()
	if err != nil {
		return UpdateInfo{}, err
	}
	return evaluateReleases(appVersion, rels), nil
}

func fetchReleases() ([]ghRelease, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", updateAPI, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "RemoteTerminal-updater")
	resp, err := updateHTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("tidak bisa terhubung ke GitHub: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("GitHub menjawab HTTP %d", resp.StatusCode)
	}
	var rels []ghRelease
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&rels); err != nil {
		return nil, fmt.Errorf("data rilis tidak dikenali: %w", err)
	}
	return rels, nil
}

// updateDir is where updates are saved (tests point it elsewhere).
var updateDir = downloadsDir

// downloadsDir is the user's Downloads folder (falls back to the home folder).
func downloadsDir() string {
	if d := knownDownloadsDir(); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	if d := filepath.Join(home, "Downloads"); dirExists(d) {
		return d
	}
	return home
}

func dirExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

// DownloadUpdate saves the new executable in the Downloads folder as
// RemoteTerminal.exe and returns its full path. Progress is reported with
// "update:progress" events ({done, total}).
func (a *App) DownloadUpdate(url string) (string, error) {
	if !strings.HasPrefix(url, updateDLPrefix) {
		return "", errors.New("alamat unduhan tidak valid")
	}
	resp, err := http.Get(url) // GitHub redirects to its file storage
	if err != nil {
		return "", fmt.Errorf("gagal mengunduh: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("gagal mengunduh: HTTP %d", resp.StatusCode)
	}
	dir := updateDir()
	tmp, err := os.CreateTemp(dir, "RemoteTerminal-*.part")
	if err != nil {
		return "", err
	}
	total, done := resp.ContentLength, int64(0)
	last := time.Time{}
	buf := make([]byte, 256<<10)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := tmp.Write(buf[:n]); werr != nil {
				tmp.Close()
				os.Remove(tmp.Name())
				return "", werr
			}
			done += int64(n)
			if time.Since(last) > 150*time.Millisecond {
				last = time.Now()
				a.emit("update:progress", map[string]int64{"done": done, "total": total})
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			tmp.Close()
			os.Remove(tmp.Name())
			return "", fmt.Errorf("unduhan terputus: %w", rerr)
		}
	}
	tmp.Close()
	if total > 0 && done != total {
		os.Remove(tmp.Name())
		return "", fmt.Errorf("unduhan tidak lengkap (%d dari %d byte)", done, total)
	}
	a.emit("update:progress", map[string]int64{"done": done, "total": done})
	// RemoteTerminal.exe, or RemoteTerminal (2).exe … when that name is taken
	// by a file that cannot be replaced (e.g. it is running).
	for i := 1; i < 100; i++ {
		name := updateExeName
		if i > 1 {
			name = fmt.Sprintf("RemoteTerminal (%d).exe", i)
		}
		dst := filepath.Join(dir, name)
		if _, err := os.Stat(dst); err == nil {
			if os.Remove(dst) != nil {
				continue
			}
		}
		if err := os.Rename(tmp.Name(), dst); err == nil {
			return dst, nil
		}
	}
	os.Remove(tmp.Name())
	return "", errors.New("tidak bisa menyimpan file di folder Download")
}

// AppLocation tells the UI where the running .exe and its data live, for the
// update instructions.
type AppLocation struct {
	ExePath    string `json:"exePath"`
	ExeDir     string `json:"exeDir"`
	ConfigPath string `json:"configPath"`
}

func (a *App) GetAppLocation() AppLocation {
	exe, _ := os.Executable()
	return AppLocation{ExePath: exe, ExeDir: filepath.Dir(exe), ConfigPath: a.cfgPath}
}
