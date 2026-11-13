package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// Session states sent to the UI.
const (
	stateConnecting   = "connecting"
	stateConnected    = "connected"
	stateReconnecting = "reconnecting"
	stateExited       = "exited" // shell ended normally (user typed exit)
	stateError        = "error"  // gave up; user must reconnect manually
)

// The remote start-up script prints this marker (tty + shell pid) so we can
// later find which tmux client / process belongs to this terminal.
var (
	markerStart = []byte("\x1b]6973;")
	markerRe    = regexp.MustCompile(`^(/dev/[A-Za-z0-9/]+);([0-9]+)$`)
)

type SessionInfo struct {
	Cwd  string `json:"cwd"`
	Tmux string `json:"tmux"`
}

type Session struct {
	app  *App
	ID   string
	prof Profile
	pw   string

	mu        sync.Mutex
	client    *ssh.Client
	shell     *ssh.Session
	stdin     io.WriteCloser
	stopKA    chan struct{}
	cols      int
	rows      int
	state     string
	tty       string
	pid       string
	tmux      string // tmux session this terminal was last attached to
	mouseDone bool
	closed    bool
	closeCh   chan struct{}

	sftpMu sync.Mutex
	sftpc  *sftp.Client
}

func newSession(app *App, prof Profile, pw string, cols, rows int) *Session {
	return &Session{app: app, ID: newID(), prof: prof, pw: pw, cols: cols, rows: rows,
		state: stateConnecting, closeCh: make(chan struct{})}
}

func (s *Session) setState(state, msg string) {
	s.mu.Lock()
	s.state = state
	s.mu.Unlock()
	s.app.emit("s:"+s.ID, map[string]string{"state": state, "msg": msg})
}

func (s *Session) isClosed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

// startScript builds the command run on the server instead of a plain shell.
// attach: re-attach to this tmux session if it still exists (reconnect).
// create: attach-or-create this tmux session (profile setting, first connect).
// Either way the user ends in a normal login shell when tmux is gone or detached.
func startScript(attach, create string) string {
	var b strings.Builder
	b.WriteString(`printf '\033]6973;%s;%s\007' "$(tty)" "$$"; `)
	if attach != "" {
		t := shellQuote("=" + attach)
		fmt.Fprintf(&b, `if command -v tmux >/dev/null 2>&1 && tmux has-session -t %s 2>/dev/null; then tmux attach-session -t %s; fi; `, t, t)
	} else if create != "" {
		fmt.Fprintf(&b, `if command -v tmux >/dev/null 2>&1; then tmux new-session -A -s %s; fi; `, shellQuote(create))
	}
	b.WriteString(`exec "${SHELL:-/bin/sh}" -l`)
	return b.String()
}

// connect dials, opens a PTY and starts the shell. It replaces any previous connection.
func (s *Session) connect(script string) error {
	client, err := s.app.dial(s.prof, s.pw)
	if err != nil {
		return err
	}
	shell, err := client.NewSession()
	if err != nil {
		client.Close()
		return err
	}
	s.mu.Lock()
	cols, rows := s.cols, s.rows
	s.mu.Unlock()
	modes := ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 115200, ssh.TTY_OP_OSPEED: 115200}
	if err := shell.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		client.Close()
		return err
	}
	shell.Setenv("COLORTERM", "truecolor") // usually refused by sshd; harmless
	stdin, err := shell.StdinPipe()
	if err != nil {
		client.Close()
		return err
	}
	stdout, err := shell.StdoutPipe()
	if err != nil {
		client.Close()
		return err
	}
	stderr, _ := shell.StderrPipe()
	if err := shell.Start(script); err != nil {
		client.Close()
		return err
	}

	s.closeSFTP()
	stop := make(chan struct{})
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		client.Close()
		return errors.New("session closed")
	}
	s.client, s.shell, s.stdin, s.stopKA = client, shell, stdin, stop
	s.tty, s.pid, s.mouseDone = "", "", false
	s.mu.Unlock()

	go s.keepalive(client, stop)
	go s.pump(stdout, true)
	if stderr != nil {
		go s.pump(stderr, false)
	}
	return nil
}

// keepalive pings the server; if it stops answering, the connection is closed
// so the reconnect logic kicks in instead of hanging forever.
func (s *Session) keepalive(client *ssh.Client, stop chan struct{}) {
	iv := time.Duration(s.app.settings().KeepaliveSeconds) * time.Second
	if iv <= 0 {
		iv = 15 * time.Second
	}
	t := time.NewTicker(iv)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
		}
		res := make(chan error, 1)
		go func() {
			_, _, err := client.SendRequest("keepalive@openssh.com", true, nil)
			res <- err
		}()
		select {
		case err := <-res:
			if err != nil {
				client.Close()
				return
			}
		case <-time.After(2 * iv):
			client.Close()
			return
		case <-stop:
			return
		}
	}
}

// pump forwards terminal output to the UI. The first bytes are scanned for
// the tty/pid marker printed by startScript, which is removed from the stream.
func (s *Session) pump(r io.Reader, scan bool) {
	buf := make([]byte, 64*1024)
	var pending []byte
	started := time.Now()
	for {
		n, err := r.Read(buf)
		if n > 0 {
			data := buf[:n]
			if scan {
				pending = append(pending, data...)
				data = nil
				if i := bytes.Index(pending, markerStart); i >= 0 {
					if j := bytes.IndexByte(pending[i:], 0x07); j >= 0 {
						s.setMarker(string(pending[i+len(markerStart) : i+j]))
						data = append(pending[:i:i], pending[i+j+1:]...)
						pending, scan = nil, false
					}
				}
				if scan && (len(pending) > 8192 || time.Since(started) > 3*time.Second) {
					data, pending, scan = pending, nil, false
				}
			}
			if len(data) > 0 {
				s.app.emit("d:"+s.ID, base64.StdEncoding.EncodeToString(data))
			}
		}
		if err != nil {
			if len(pending) > 0 {
				s.app.emit("d:"+s.ID, base64.StdEncoding.EncodeToString(pending))
			}
			return
		}
	}
}

func (s *Session) setMarker(m string) {
	g := markerRe.FindStringSubmatch(strings.TrimSpace(m))
	if g == nil {
		return
	}
	s.mu.Lock()
	s.tty, s.pid = g[1], g[2]
	s.mu.Unlock()
	go func() { // learn tmux state soon after start
		time.Sleep(1500 * time.Millisecond)
		s.info()
	}()
}

// run waits for the shell to end and reconnects when the connection dropped.
func (s *Session) run() {
	go s.tracker()
	for {
		s.mu.Lock()
		shell, client, stop := s.shell, s.client, s.stopKA
		s.mu.Unlock()
		err := shell.Wait()
		close(stop)
		client.Close()
		if s.isClosed() {
			return
		}
		var exitErr *ssh.ExitError
		if err == nil || errors.As(err, &exitErr) {
			s.setState(stateExited, "")
			return
		}
		if !s.reconnectLoop() {
			return
		}
	}
}

func (s *Session) reconnectLoop() bool {
	delay := time.Second
	for attempt := 1; ; attempt++ {
		if s.isClosed() {
			return false
		}
		s.mu.Lock()
		tmux := s.tmux
		s.mu.Unlock()
		s.setState(stateReconnecting, fmt.Sprintf("Menyambung ulang… (percobaan %d)", attempt))
		err := s.connect(startScript(tmux, ""))
		if err == nil {
			s.setState(stateConnected, "")
			return true
		}
		if isAuthError(err) {
			s.setState(stateError, "Autentikasi gagal: "+err.Error())
			return false
		}
		select {
		case <-s.closeCh:
			return false
		case <-time.After(delay):
		}
		if delay < 10*time.Second {
			delay *= 2
		}
	}
}

// restart is used for a manual reconnect after the session ended or failed.
func (s *Session) restart(pw string) error {
	if pw != "" {
		s.pw = pw
	}
	s.setState(stateConnecting, "")
	s.mu.Lock()
	tmux := s.tmux
	s.mu.Unlock()
	script := startScript(tmux, "")
	if tmux == "" {
		script = startScript("", s.prof.TmuxSession)
	}
	if err := s.connect(script); err != nil {
		s.setState(stateError, err.Error())
		return err
	}
	s.setState(stateConnected, "")
	go s.run()
	return nil
}

// tracker refreshes tmux/cwd info periodically so a reconnect knows where to return.
func (s *Session) tracker() {
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-s.closeCh:
			return
		case <-t.C:
			s.info()
		}
	}
}

func (s *Session) write(data []byte) {
	s.mu.Lock()
	stdin, state := s.stdin, s.state
	s.mu.Unlock()
	if stdin == nil || state != stateConnected {
		return // typing while disconnected is dropped on purpose
	}
	stdin.Write(data)
}

func (s *Session) resize(cols, rows int) {
	if cols <= 0 || rows <= 0 {
		return
	}
	s.mu.Lock()
	s.cols, s.rows = cols, rows
	shell, state := s.shell, s.state
	s.mu.Unlock()
	if shell != nil && state == stateConnected {
		go shell.WindowChange(rows, cols)
	}
}

func (s *Session) close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	close(s.closeCh)
	client := s.client
	s.mu.Unlock()
	s.closeSFTP()
	if client != nil {
		client.Close()
	}
}

// runCmd executes a short command on a separate channel with a timeout.
func (s *Session) runCmd(cmd string, timeout time.Duration) (string, error) {
	s.mu.Lock()
	client, state := s.client, s.state
	s.mu.Unlock()
	if client == nil || state != stateConnected {
		return "", errors.New("tidak terhubung")
	}
	sess, err := client.NewSession()
	if err != nil {
		return "", err
	}
	defer sess.Close()
	type result struct {
		out []byte
		err error
	}
	ch := make(chan result, 1)
	go func() {
		out, err := sess.Output(cmd)
		ch <- result{out, err}
	}()
	select {
	case r := <-ch:
		return string(r.out), r.err
	case <-time.After(timeout):
		return "", errors.New("timeout")
	}
}

// info finds the current directory and tmux session of this terminal.
func (s *Session) info() (SessionInfo, error) {
	s.mu.Lock()
	tty, pid := s.tty, s.pid
	s.mu.Unlock()
	if pid == "" {
		return SessionInfo{}, errors.New("info belum tersedia")
	}
	cmd := `tmux list-clients -F '#{client_tty}|#{session_name}|#{pane_current_path}' 2>/dev/null; echo '@@'; readlink /proc/` + pid + `/cwd 2>/dev/null`
	out, err := s.runCmd(cmd, 8*time.Second)
	if err != nil && out == "" {
		return SessionInfo{}, err
	}
	var info SessionInfo
	parts := strings.SplitN(out, "@@", 2)
	for _, line := range strings.Split(parts[0], "\n") {
		f := strings.SplitN(strings.TrimSpace(line), "|", 3)
		if len(f) == 3 && f[0] == tty {
			info.Tmux, info.Cwd = f[1], f[2]
		}
	}
	if info.Tmux == "" && len(parts) == 2 {
		info.Cwd = strings.TrimSpace(parts[1])
	}
	s.mu.Lock()
	s.tmux = info.Tmux
	needMouse := info.Tmux != "" && !s.mouseDone && s.app.settings().TmuxMouse
	if needMouse {
		s.mouseDone = true
	}
	s.mu.Unlock()
	if needMouse {
		// Mouse mode lets the wheel scroll tmux history without holding Shift.
		s.runCmd(`tmux set -g mouse on`, 5*time.Second)
	}
	return info, nil
}

func (s *Session) getSFTP() (*sftp.Client, error) {
	s.sftpMu.Lock()
	defer s.sftpMu.Unlock()
	if s.sftpc != nil {
		return s.sftpc, nil
	}
	s.mu.Lock()
	client, state := s.client, s.state
	s.mu.Unlock()
	if client == nil || state != stateConnected {
		return nil, errors.New("tidak terhubung")
	}
	c, err := sftp.NewClient(client,
		sftp.UseConcurrentWrites(true),
		sftp.UseConcurrentReads(true),
		sftp.MaxConcurrentRequestsPerFile(64))
	if err != nil {
		return nil, fmt.Errorf("SFTP tidak tersedia: %w", err)
	}
	s.sftpc = c
	return c, nil
}

func (s *Session) closeSFTP() {
	s.sftpMu.Lock()
	if s.sftpc != nil {
		s.sftpc.Close()
		s.sftpc = nil
	}
	s.sftpMu.Unlock()
}

func isAuthError(err error) bool {
	return err != nil && strings.Contains(err.Error(), "unable to authenticate")
}

// dial opens an authenticated SSH connection.
func (a *App) dial(p Profile, pw string) (*ssh.Client, error) {
	addr := net.JoinHostPort(p.Host, strconv.Itoa(p.Port))
	cfg := &ssh.ClientConfig{
		User: p.User,
		Auth: []ssh.AuthMethod{
			ssh.Password(pw),
			ssh.KeyboardInteractive(func(name, instr string, qs []string, echos []bool) ([]string, error) {
				ans := make([]string, len(qs))
				for i := range qs {
					if !echos[i] {
						ans[i] = pw
					}
				}
				return ans, nil
			}),
		},
		HostKeyCallback:   a.hostKeyCallback(),
		HostKeyAlgorithms: a.knownHostAlgorithms(addr),
		Timeout:           15 * time.Second,
	}
	d := net.Dialer{Timeout: 15 * time.Second, KeepAlive: 15 * time.Second}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	// The handshake may wait on the user to accept a host key, so allow time for that.
	conn.SetDeadline(time.Now().Add(5 * time.Minute))
	c, chans, reqs, err := ssh.NewClientConn(conn, addr, cfg)
	if err != nil {
		conn.Close()
		return nil, err
	}
	conn.SetDeadline(time.Time{})
	return ssh.NewClient(c, chans, reqs), nil
}
