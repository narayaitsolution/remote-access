package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/BurntSushi/toml"
)

const configFileName = "config.toml"

// Settings are global application settings stored in [settings].
type Settings struct {
	FontFamily       string            `toml:"font_family" json:"fontFamily"`
	FontSize         int               `toml:"font_size" json:"fontSize"`
	Scrollback       int               `toml:"scrollback" json:"scrollback"`
	CopyOnSelect     bool              `toml:"copy_on_select" json:"copyOnSelect"`
	SidebarVisible   bool              `toml:"sidebar_visible" json:"sidebarVisible"`
	SidebarWidth     int               `toml:"sidebar_width" json:"sidebarWidth"`
	SidebarFollow    bool              `toml:"sidebar_follow" json:"sidebarFollow"`
	KeepaliveSeconds int               `toml:"keepalive_seconds" json:"keepaliveSeconds"`
	TmuxMouse        bool              `toml:"tmux_mouse" json:"tmuxMouse"`
	DownloadDir      string            `toml:"download_dir" json:"downloadDir"`
	Keys             map[string]string `toml:"keys" json:"keys"`
}

// Profile is one saved server ([[profile]] in config.toml).
type Profile struct {
	ID          string `toml:"id"`
	Name        string `toml:"name"`
	Host        string `toml:"host"`
	Port        int    `toml:"port"`
	User        string `toml:"user"`
	Password    string `toml:"password,omitempty"` // "dpapi:<base64>" — encrypted for the current Windows user
	AuthType    string `toml:"auth,omitempty"`     // "password" (default) or "key"; for "key", Password holds the key passphrase
	KeyPath     string `toml:"key_path,omitempty"` // private key file, e.g. C:/Users/me/.ssh/id_ed25519
	TmuxSession string `toml:"tmux_session,omitempty"`
}

func (p Profile) authType() string {
	if p.AuthType == "key" {
		return "key"
	}
	return "password"
}

// ProfileView is what the UI sees: never the password itself.
type ProfileView struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	User        string `json:"user"`
	HasPassword bool   `json:"hasPassword"`
	AuthType    string `json:"authType"`
	KeyPath     string `json:"keyPath"`
	TmuxSession string `json:"tmuxSession"`
}

// ProfileInput is sent by the UI when creating or editing a profile.
type ProfileInput struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Host         string `json:"host"`
	Port         int    `json:"port"`
	User         string `json:"user"`
	Password     string `json:"password"`
	SavePassword bool   `json:"savePassword"`
	KeepPassword bool   `json:"keepPassword"` // editing: leave the stored password unchanged
	AuthType     string `json:"authType"`
	KeyPath      string `json:"keyPath"`
	TmuxSession  string `json:"tmuxSession"`
}

type Config struct {
	Settings Settings  `toml:"settings"`
	Profiles []Profile `toml:"profile"`
}

func defaultKeys() map[string]string {
	return map[string]string{
		"new_tab":          "Ctrl+Shift+T",
		"split_vertical":   "Ctrl+Shift+E",
		"split_horizontal": "Ctrl+Shift+O",
		"close_pane":       "Ctrl+Shift+W",
		"next_tab":         "Ctrl+Tab",
		"prev_tab":         "Ctrl+Shift+Tab",
		"focus_left":       "Alt+Left",
		"focus_right":      "Alt+Right",
		"focus_up":         "Alt+Up",
		"focus_down":       "Alt+Down",
		"toggle_sidebar":   "Ctrl+Shift+B",
		"copy":             "Ctrl+Shift+C",
		"paste":            "Ctrl+Shift+V",
		"fullscreen":       "F11",
	}
}

func defaultConfig() Config {
	return Config{Settings: Settings{
		FontFamily:       "'Cascadia Mono', Consolas, 'Courier New', monospace",
		FontSize:         14,
		Scrollback:       10000,
		CopyOnSelect:     true,
		SidebarVisible:   true,
		SidebarWidth:     300,
		SidebarFollow:    true,
		KeepaliveSeconds: 15,
		TmuxMouse:        true,
		Keys:             defaultKeys(),
	}}
}

// configDir returns the folder next to the .exe if writable (portable mode),
// otherwise %APPDATA%\RemoteTerminal.
func configDir() string {
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		probe := filepath.Join(dir, ".write-test")
		if f, err := os.Create(probe); err == nil {
			f.Close()
			os.Remove(probe)
			return dir
		}
	}
	if app, err := os.UserConfigDir(); err == nil {
		dir := filepath.Join(app, "RemoteTerminal")
		os.MkdirAll(dir, 0o700)
		return dir
	}
	return "."
}

func loadConfig(path string) (Config, error) {
	cfg := defaultConfig()
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return cfg, saveConfig(path, cfg)
	}
	if err != nil {
		return cfg, err
	}
	if _, err := toml.Decode(string(data), &cfg); err != nil {
		return defaultConfig(), fmt.Errorf("config.toml tidak valid: %w", err)
	}
	// Fill in any shortcut missing from the file.
	if cfg.Settings.Keys == nil {
		cfg.Settings.Keys = map[string]string{}
	}
	for k, v := range defaultKeys() {
		if _, ok := cfg.Settings.Keys[k]; !ok {
			cfg.Settings.Keys[k] = v
		}
	}
	for i := range cfg.Profiles {
		if cfg.Profiles[i].ID == "" {
			cfg.Profiles[i].ID = newID()
		}
		if cfg.Profiles[i].Port == 0 {
			cfg.Profiles[i].Port = 22
		}
	}
	return cfg, nil
}

func saveConfig(path string, cfg Config) error {
	var buf bytes.Buffer
	buf.WriteString("# Remote Terminal configuration.\n")
	buf.WriteString("# Passwords are encrypted with Windows DPAPI and only readable by the same Windows user.\n\n")
	if err := toml.NewEncoder(&buf).Encode(cfg); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, buf.Bytes(), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (p Profile) view() ProfileView {
	return ProfileView{ID: p.ID, Name: p.Name, Host: p.Host, Port: p.Port, User: p.User,
		HasPassword: p.Password != "", AuthType: p.authType(), KeyPath: p.KeyPath, TmuxSession: p.TmuxSession}
}

func newID() string {
	b := make([]byte, 6)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// shellQuote quotes s for a POSIX shell.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
