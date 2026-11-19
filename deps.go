package main

// Environment check: which optional programs are present, and installing
// missing ones with winget. Features whose program is missing stay disabled.

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type DepStatus struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Purpose     string `json:"purpose"`
	Status      string `json:"status"` // ok | missing | builtin
	Detail      string `json:"detail"`
	Installable bool   `json:"installable"` // can be installed automatically
	NeedsLogin  bool   `json:"needsLogin"`  // installed CLI must be logged in once
	Manual      string `json:"manual"`      // manual install hint
}

type depSpec struct {
	id, name, purpose, wingetID, manual string
	needsLogin                          bool
	check                               func() (bool, string)
}

func lookPath(name string) (bool, string) {
	p, err := exec.LookPath(name)
	return err == nil, p
}

func officeCheck() (bool, string) {
	for _, ext := range []string{".docx", ".xlsx", ".pptx"} {
		if app := associatedApp(ext); app != "" {
			return true, app
		}
	}
	for _, base := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)")} {
		if base == "" {
			continue
		}
		if p := filepath.Join(base, "LibreOffice", "program", "soffice.exe"); fileExists(p) {
			return true, p
		}
	}
	return false, ""
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

// depSpecs is built on each call so the texts follow the UI language.
func depSpecs() []depSpec {
	return []depSpec{
		{id: "claude", name: "Claude Code CLI", purpose: L("Asisten AI: Claude", "AI assistant: Claude"), wingetID: "Anthropic.ClaudeCode", needsLogin: true,
			manual: "https://docs.anthropic.com/claude-code", check: func() (bool, string) { return lookPath("claude") }},
		{id: "codex", name: "Codex CLI", purpose: L("Asisten AI: Codex", "AI assistant: Codex"), wingetID: "OpenAI.Codex", needsLogin: true,
			manual: "https://github.com/openai/codex", check: func() (bool, string) { return lookPath("codex") }},
		{id: "office", name: "Microsoft Office / LibreOffice", purpose: L("Membuka & mengedit Word, Excel, PowerPoint", "Open & edit Word, Excel, PowerPoint"),
			wingetID: "TheDocumentFoundation.LibreOffice", manual: L("Pasang Microsoft Office atau https://www.libreoffice.org", "Install Microsoft Office or https://www.libreoffice.org"),
			check: officeCheck},
	}
}

// CheckDeps reports every dependency and the built-in features.
func (a *App) CheckDeps() []DepStatus {
	refreshPath()
	winget, _ := lookPath("winget")
	out := []DepStatus{
		{ID: "builtin", Name: L("Terminal SSH, SFTP, editor kode (VS Code/Monaco), PDF, Markdown, gambar, AI via URL OpenAI-compatible", "SSH terminal, SFTP, code editor (VS Code/Monaco), PDF, Markdown, images, AI via OpenAI-compatible URL"),
			Purpose: L("Fitur bawaan", "Built-in features"), Status: "builtin", Detail: L("Sudah termasuk di dalam aplikasi", "Included in the app")},
	}
	for _, d := range depSpecs() {
		ok, detail := d.check()
		st := DepStatus{ID: d.id, Name: d.name, Purpose: d.purpose, Status: "missing", Detail: detail,
			Installable: winget && d.wingetID != "", NeedsLogin: d.needsLogin, Manual: d.manual}
		if ok {
			st.Status = "ok"
		}
		out = append(out, st)
	}
	if !winget {
		out = append(out, DepStatus{ID: "winget", Name: "Windows Package Manager (winget)", Purpose: L("Pemasangan otomatis", "Automatic installation"),
			Status: "missing", Manual: L("Pasang \"App Installer\" dari Microsoft Store", "Install \"App Installer\" from the Microsoft Store")})
	}
	return out
}

// InstallDep installs one dependency with winget, streaming output as "dep:log" events.
func (a *App) InstallDep(id string) error {
	var spec *depSpec
	specs := depSpecs()
	for i := range specs {
		if specs[i].id == id {
			spec = &specs[i]
		}
	}
	if spec == nil || spec.wingetID == "" {
		return errors.New(L("tidak bisa dipasang otomatis", "cannot be installed automatically"))
	}
	winget, err := exec.LookPath("winget")
	if err != nil {
		return errors.New(L("winget tidak tersedia; pasang \"App Installer\" dari Microsoft Store", "winget is not available; install \"App Installer\" from the Microsoft Store"))
	}
	cmd := exec.Command(winget, "install", "--id", spec.wingetID, "-e", "--silent",
		"--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity")
	hideWindow(cmd)
	pr, pw := io.Pipe()
	cmd.Stdout, cmd.Stderr = pw, pw
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() {
		sc := bufio.NewScanner(pr)
		for sc.Scan() {
			line := strings.TrimSpace(strings.Trim(sc.Text(), "\r\b-\\|/ "))
			if len(line) > 2 && !strings.ContainsAny(line, "█▒") {
				a.emit("dep:log", map[string]string{"id": id, "line": line})
			}
		}
	}()
	err = cmd.Wait()
	pw.Close()
	refreshPath()
	if ok, _ := spec.check(); ok {
		return nil
	}
	if err != nil {
		return fmt.Errorf(L("winget gagal: %w", "winget failed: %w"), err)
	}
	return errors.New(L("terpasang, tetapi belum terdeteksi; coba buka ulang aplikasi", "installed, but not detected yet; try reopening the app"))
}

// LoginAI opens a console window where the user logs in to the AI CLI once.
func (a *App) LoginAI(provider string) error {
	refreshPath()
	var args []string
	switch provider {
	case "claude":
		args = []string{"claude"}
	case "codex":
		args = []string{"codex", "login"}
	default:
		return errors.New(L("provider tidak dikenal", "unknown provider"))
	}
	if _, err := exec.LookPath(args[0]); err != nil {
		return fmt.Errorf(L("%s belum terpasang", "%s is not installed"), args[0])
	}
	cmd := exec.Command("cmd", append([]string{"/c", "start", "Login " + args[0], "cmd", "/k"}, args...)...)
	return cmd.Start()
}

// MarkSetupDone records that the first-run environment check was shown.
func (a *App) MarkSetupDone() error {
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	a.cfg.Settings.SetupDone = true
	return saveConfig(a.cfgPath, a.cfg)
}
