package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App holds global state. Its exported methods are callable from the UI.
type App struct {
	ctx     context.Context
	dir     string
	cfgPath string

	cfgMu  sync.Mutex
	cfg    Config
	cfgErr string

	sessMu   sync.Mutex
	sessions map[string]*Session

	hostMu   sync.Mutex
	hostWait map[string]chan bool

	xferMu sync.Mutex
	xfers  map[string]*Transfer

	ai aiState

	emitHook func(name string, data any) // replaces UI events in tests
}

func NewApp() *App {
	return &App{sessions: map[string]*Session{}, hostWait: map[string]chan bool{}, xfers: map[string]*Transfer{},
		ai: aiState{chats: map[string]*aiChat{}, pending: map[string]chan aiToolResult{}}}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.dir = configDir()
	a.cfgPath = filepath.Join(a.dir, configFileName)
	cfg, err := loadConfig(a.cfgPath)
	a.cfg = cfg
	if err != nil {
		a.cfgErr = err.Error()
	}
}

func (a *App) shutdown(ctx context.Context) {
	a.shutdownAI()
	a.sessMu.Lock()
	defer a.sessMu.Unlock()
	for _, s := range a.sessions {
		s.close()
	}
}

func (a *App) emit(name string, data any) {
	if a.emitHook != nil { // tests
		a.emitHook(name, data)
		return
	}
	if a.ctx != nil {
		runtime.EventsEmit(a.ctx, name, data)
	}
}

func (a *App) settings() Settings {
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	return a.cfg.Settings
}

func (a *App) session(id string) (*Session, error) {
	a.sessMu.Lock()
	defer a.sessMu.Unlock()
	s, ok := a.sessions[id]
	if !ok {
		return nil, errors.New("sesi tidak ditemukan")
	}
	return s, nil
}

// ---------- configuration ----------

type AppState struct {
	Settings   Settings      `json:"settings"`
	Profiles   []ProfileView `json:"profiles"`
	ConfigPath string        `json:"configPath"`
	ConfigErr  string        `json:"configError"`
}

func (a *App) GetState() AppState {
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	views := make([]ProfileView, 0, len(a.cfg.Profiles))
	for _, p := range a.cfg.Profiles {
		views = append(views, p.view())
	}
	return AppState{Settings: a.cfg.Settings, Profiles: views, ConfigPath: a.cfgPath, ConfigErr: a.cfgErr}
}

func (a *App) SaveProfile(in ProfileInput) (ProfileView, error) {
	in.Name, in.Host, in.User = strings.TrimSpace(in.Name), strings.TrimSpace(in.Host), strings.TrimSpace(in.User)
	if in.Host == "" || in.User == "" {
		return ProfileView{}, errors.New("host dan user wajib diisi")
	}
	if in.Port <= 0 || in.Port > 65535 {
		in.Port = 22
	}
	if in.Name == "" {
		in.Name = in.User + "@" + in.Host
	}
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	idx := -1
	for i, p := range a.cfg.Profiles {
		if in.ID != "" && p.ID == in.ID {
			idx = i
		}
	}
	p := Profile{ID: in.ID, Name: in.Name, Host: in.Host, Port: in.Port, User: in.User, TmuxSession: strings.TrimSpace(in.TmuxSession)}
	if in.AuthType == "key" {
		p.AuthType, p.KeyPath = "key", strings.TrimSpace(in.KeyPath)
		if p.KeyPath == "" {
			return ProfileView{}, errors.New("pilih file private key")
		}
		// Reject unreadable / wrong-format files now; an encrypted key is fine.
		if _, err := loadKey(p.KeyPath, ""); err != nil && !isAuthError(err) {
			return ProfileView{}, err
		}
	}
	if idx >= 0 && in.KeepPassword {
		p.Password = a.cfg.Profiles[idx].Password
	} else if in.SavePassword && in.Password != "" {
		enc, err := encryptSecret(in.Password)
		if err != nil {
			return ProfileView{}, err
		}
		p.Password = enc
	}
	if idx >= 0 {
		a.cfg.Profiles[idx] = p
	} else {
		p.ID = newID()
		a.cfg.Profiles = append(a.cfg.Profiles, p)
	}
	return p.view(), saveConfig(a.cfgPath, a.cfg)
}

func (a *App) DeleteProfile(id string) error {
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	out := a.cfg.Profiles[:0]
	for _, p := range a.cfg.Profiles {
		if p.ID != id {
			out = append(out, p)
		}
	}
	a.cfg.Profiles = out
	return saveConfig(a.cfgPath, a.cfg)
}

// MoveProfile reorders the server list.
func (a *App) MoveProfile(id string, delta int) error {
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	ps := a.cfg.Profiles
	for i := range ps {
		if ps[i].ID == id {
			j := i + delta
			if j < 0 || j >= len(ps) {
				return nil
			}
			ps[i], ps[j] = ps[j], ps[i]
			return saveConfig(a.cfgPath, a.cfg)
		}
	}
	return nil
}

func (a *App) SaveSettings(s Settings) error {
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	if s.Keys == nil {
		s.Keys = a.cfg.Settings.Keys
	}
	a.cfg.Settings = s
	return saveConfig(a.cfgPath, a.cfg)
}

func (a *App) profile(id string) (Profile, error) {
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	for _, p := range a.cfg.Profiles {
		if p.ID == id {
			return p, nil
		}
	}
	return Profile{}, errors.New("profil tidak ditemukan")
}

// PickKeyFile lets the user choose a private key file (starts in ~/.ssh).
func (a *App) PickKeyFile() (string, error) {
	dir := ""
	if home, err := os.UserHomeDir(); err == nil {
		dir = filepath.Join(home, ".ssh")
	}
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Pilih private key SSH", DefaultDirectory: dir})
}

// ---------- terminal sessions ----------

// Connect opens a new terminal session. An empty password uses the stored one.
// Errors starting with "auth:" mean the password was wrong.
func (a *App) Connect(profileID, password string, savePassword bool, cols, rows int) (string, error) {
	p, err := a.profile(profileID)
	if err != nil {
		return "", err
	}
	pw := password
	if pw == "" && p.Password != "" {
		if pw, err = decryptSecret(p.Password); err != nil {
			return "", errors.New("auth:" + err.Error())
		}
	}
	s := newSession(a, p, pw, cols, rows)
	if err := s.connect(startScript("", p.TmuxSession)); err != nil {
		if isAuthError(err) {
			return "", errors.New("auth:" + authMessage(p, err))
		}
		return "", err
	}
	if password != "" && savePassword {
		if enc, err := encryptSecret(password); err == nil {
			a.cfgMu.Lock()
			for i := range a.cfg.Profiles {
				if a.cfg.Profiles[i].ID == p.ID {
					a.cfg.Profiles[i].Password = enc
				}
			}
			saveConfig(a.cfgPath, a.cfg)
			a.cfgMu.Unlock()
		}
	}
	a.sessMu.Lock()
	a.sessions[s.ID] = s
	a.sessMu.Unlock()
	s.setState(stateConnected, "")
	go s.run()
	return s.ID, nil
}

// Reconnect restarts a session that ended or failed. Empty password = reuse.
func (a *App) Reconnect(id, password string) error {
	s, err := a.session(id)
	if err != nil {
		return err
	}
	err = s.restart(password)
	if isAuthError(err) {
		return errors.New("auth:" + authMessage(s.prof, err))
	}
	return err
}

func (a *App) Write(id, data string) {
	if s, err := a.session(id); err == nil {
		s.write([]byte(data))
	}
}

// WriteBinary is for raw bytes (e.g. legacy mouse reports) sent base64-encoded.
func (a *App) WriteBinary(id, b64 string) {
	if s, err := a.session(id); err == nil {
		if b, err := base64.StdEncoding.DecodeString(b64); err == nil {
			s.write(b)
		}
	}
}

func (a *App) Resize(id string, cols, rows int) {
	if s, err := a.session(id); err == nil {
		s.resize(cols, rows)
	}
}

func (a *App) Close(id string) {
	a.sessMu.Lock()
	s := a.sessions[id]
	delete(a.sessions, id)
	a.sessMu.Unlock()
	if s != nil {
		go s.close()
	}
}

func (a *App) Info(id string) (SessionInfo, error) {
	s, err := a.session(id)
	if err != nil {
		return SessionInfo{}, err
	}
	return s.info()
}

func (a *App) HostKeyAnswer(reqID string, accept bool) {
	a.hostMu.Lock()
	ch := a.hostWait[reqID]
	a.hostMu.Unlock()
	if ch != nil {
		select {
		case ch <- accept:
		default:
		}
	}
}

// ---------- files (SFTP) ----------

func (a *App) ListDir(id, path string) (DirListing, error) {
	s, err := a.session(id)
	if err != nil {
		return DirListing{}, err
	}
	return s.listDir(path)
}

func (a *App) Mkdir(id, path string) error {
	s, err := a.session(id)
	if err != nil {
		return err
	}
	return s.mkdir(path)
}

func (a *App) CreateFile(id, path string) error {
	s, err := a.session(id)
	if err != nil {
		return err
	}
	return s.createFile(path)
}

func (a *App) Rename(id, from, to string) error {
	s, err := a.session(id)
	if err != nil {
		return err
	}
	return s.rename(from, to)
}

func (a *App) Remove(id string, paths []string) error {
	s, err := a.session(id)
	if err != nil {
		return err
	}
	return s.remove(paths)
}

func (a *App) Chmod(id, path, mode string) error {
	s, err := a.session(id)
	if err != nil {
		return err
	}
	return s.chmod(path, mode)
}

// Upload sends local files/folders (e.g. dropped from Explorer) to remoteDir.
func (a *App) Upload(id string, localPaths []string, remoteDir string) error {
	s, err := a.session(id)
	if err != nil {
		return err
	}
	a.upload(s, localPaths, remoteDir)
	return nil
}

// UploadDialog lets the user pick files (or one folder) to upload.
func (a *App) UploadDialog(id, remoteDir string, folder bool) error {
	s, err := a.session(id)
	if err != nil {
		return err
	}
	var paths []string
	if folder {
		p, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{Title: "Pilih folder untuk di-upload"})
		if err != nil || p == "" {
			return err
		}
		paths = []string{p}
	} else {
		paths, err = runtime.OpenMultipleFilesDialog(a.ctx, runtime.OpenDialogOptions{Title: "Pilih file untuk di-upload"})
		if err != nil {
			return err
		}
	}
	a.upload(s, paths, remoteDir)
	return nil
}

// DownloadDialog asks for a local folder and downloads the remote paths into it.
func (a *App) DownloadDialog(id string, remotePaths []string) error {
	s, err := a.session(id)
	if err != nil {
		return err
	}
	dir, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Simpan ke folder", DefaultDirectory: a.settings().DownloadDir})
	if err != nil || dir == "" {
		return err
	}
	a.cfgMu.Lock()
	a.cfg.Settings.DownloadDir = dir
	saveConfig(a.cfgPath, a.cfg)
	a.cfgMu.Unlock()
	a.download(s, remotePaths, dir)
	return nil
}

func (a *App) CancelTransfer(id string) {
	a.xferMu.Lock()
	t := a.xfers[id]
	a.xferMu.Unlock()
	if t != nil {
		t.cancel()
	}
}

// OpenLocalFolder shows a downloaded folder in Explorer.
func (a *App) OpenLocalFolder(dir string) {
	exec.Command("explorer", filepath.Clean(dir)).Start()
}

// ---------- helpers for AI tools ----------

// CaptureTmux returns the history of the tmux pane this terminal shows
// (wrapped lines joined), or an error when the terminal is not in tmux.
func (a *App) CaptureTmux(id string, lines int) (string, error) {
	s, err := a.session(id)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	tty := s.tty
	s.mu.Unlock()
	if tty == "" {
		return "", errors.New("tty belum diketahui")
	}
	if lines <= 0 || lines > 5000 {
		lines = 2000
	}
	cmd := fmt.Sprintf(`p=$(tmux display-message -p -c %s '#{pane_id}' 2>/dev/null) && [ -n "$p" ] && tmux capture-pane -p -J -S -%d -t "$p"`, shellQuote(tty), lines)
	out, err := s.runCmd(cmd, 10*time.Second)
	if err != nil {
		return "", errors.New("bukan di dalam tmux")
	}
	return out, nil
}

// ReadFileText reads up to maxBytes of a remote file.
func (a *App) ReadFileText(id, path string, maxBytes int) (string, error) {
	s, err := a.session(id)
	if err != nil {
		return "", err
	}
	c, err := s.getSFTP()
	if err != nil {
		return "", err
	}
	if maxBytes <= 0 || maxBytes > 2<<20 {
		maxBytes = 200000
	}
	f, err := c.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	buf, err := io.ReadAll(io.LimitReader(f, int64(maxBytes)+1))
	if err != nil {
		return "", err
	}
	truncated := len(buf) > maxBytes
	if truncated {
		buf = buf[:maxBytes]
	}
	if bytes.IndexByte(buf, 0) >= 0 {
		return "", errors.New("file biner, tidak bisa dibaca sebagai teks")
	}
	text := string(buf)
	if truncated {
		text += fmt.Sprintf("\n[... dipotong setelah %d byte]", maxBytes)
	}
	return text, nil
}

// WriteFileText creates or overwrites a remote text file.
func (a *App) WriteFileText(id, path, content string) error {
	s, err := a.session(id)
	if err != nil {
		return err
	}
	c, err := s.getSFTP()
	if err != nil {
		return err
	}
	f, err := c.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		return err
	}
	if _, err := io.WriteString(f, content); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
