package main

// Integration tests against an in-process fake SSH server: login, tty marker,
// tmux tracking, auto-reconnect into the same tmux session, keepalive timeout,
// and SFTP file operations / transfers.

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

type fakeServer struct {
	t        *testing.T
	ln       net.Listener
	cfg      *ssh.ServerConfig
	pub      ssh.PublicKey
	mu       sync.Mutex
	conns    []net.Conn
	starts   []string // start scripts received
	freeze   bool     // stop answering keepalives
	sftpRoot sftp.Handlers
}

func newFakeServer(t *testing.T) *fakeServer {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(priv)
	fs := &fakeServer{t: t, pub: signer.PublicKey(), sftpRoot: sftp.InMemHandler()}
	fs.cfg = &ssh.ServerConfig{
		PasswordCallback: func(c ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
			if c.User() == "u" && string(pw) == "secret" {
				return nil, nil
			}
			return nil, io.EOF
		},
	}
	fs.cfg.AddHostKey(signer)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	fs.ln = ln
	go fs.serve()
	t.Cleanup(func() { ln.Close(); fs.dropAll() })
	return fs
}

func (fs *fakeServer) addr() string { return fs.ln.Addr().String() }

func (fs *fakeServer) dropAll() {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	for _, c := range fs.conns {
		c.Close()
	}
	fs.conns = nil
}

func (fs *fakeServer) startCount() int {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	return len(fs.starts)
}

func (fs *fakeServer) serve() {
	for {
		nc, err := fs.ln.Accept()
		if err != nil {
			return
		}
		fs.mu.Lock()
		fs.conns = append(fs.conns, nc)
		fs.mu.Unlock()
		go fs.handle(nc)
	}
}

func (fs *fakeServer) handle(nc net.Conn) {
	_, chans, reqs, err := ssh.NewServerConn(nc, fs.cfg)
	if err != nil {
		return
	}
	go func() {
		for r := range reqs {
			fs.mu.Lock()
			frozen := fs.freeze
			fs.mu.Unlock()
			if !frozen && r.WantReply {
				r.Reply(false, nil) // like OpenSSH: unknown request, but answered
			}
		}
	}()
	for nch := range chans {
		ch, creqs, err := nch.Accept()
		if err != nil {
			continue
		}
		go fs.session(ch, creqs)
	}
}

func exitStatus(ch ssh.Channel, code uint32) {
	b := make([]byte, 4)
	binary.BigEndian.PutUint32(b, code)
	ch.SendRequest("exit-status", false, b)
	ch.Close()
}

func (fs *fakeServer) session(ch ssh.Channel, reqs <-chan *ssh.Request) {
	for r := range reqs {
		switch r.Type {
		case "pty-req", "window-change":
			r.Reply(true, nil)
		case "exec":
			r.Reply(true, nil)
			cmd := string(r.Payload[4:])
			switch {
			case strings.Contains(cmd, "tmux list-clients"):
				io.WriteString(ch, "/dev/pts/9|main|/home/test/project\n/dev/pts/2|other|/tmp\n@@\n/home/test\n")
				exitStatus(ch, 0)
			case strings.Contains(cmd, "tmux set"):
				exitStatus(ch, 0)
			case strings.Contains(cmd, "6973"):
				fs.mu.Lock()
				fs.starts = append(fs.starts, cmd)
				fs.mu.Unlock()
				io.WriteString(ch, "\x1b]6973;/dev/pts/9;4321\x07welcome$ ")
				go func() { // echo shell; "exit\r" ends it cleanly
					buf := make([]byte, 1024)
					for {
						n, err := ch.Read(buf)
						if err != nil {
							return
						}
						ch.Write(buf[:n])
						if strings.Contains(string(buf[:n]), "exit\r") {
							exitStatus(ch, 0)
							return
						}
					}
				}()
			default:
				exitStatus(ch, 127)
			}
		case "subsystem":
			r.Reply(true, nil)
			srv := sftp.NewRequestServer(ch, fs.sftpRoot)
			go func() { srv.Serve(); srv.Close() }()
		default:
			r.Reply(false, nil)
		}
	}
}

func testApp(t *testing.T, fs *fakeServer) (*App, Profile) {
	dir := t.TempDir()
	a := NewApp()
	a.dir = dir
	a.cfgPath = filepath.Join(dir, configFileName)
	a.cfg = defaultConfig()
	a.cfg.Settings.KeepaliveSeconds = 1
	line := knownhosts.Line([]string{knownhosts.Normalize(fs.addr())}, fs.pub)
	os.WriteFile(a.knownHostsPath(), []byte(line+"\n"), 0o600)
	host, port, _ := net.SplitHostPort(fs.addr())
	p := Profile{ID: "p1", Name: "test", Host: host, User: "u"}
	for _, c := range port {
		p.Port = p.Port*10 + int(c-'0')
	}
	return a, p
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", what)
}

func (s *Session) snapshot() (state, tty, pid, tmux string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state, s.tty, s.pid, s.tmux
}

func TestWrongPassword(t *testing.T) {
	fs := newFakeServer(t)
	a, p := testApp(t, fs)
	s := newSession(a, p, "wrong", 80, 24)
	err := s.connect(startScript("", ""))
	if !isAuthError(err) {
		t.Fatalf("want auth error, got %v", err)
	}
}

func TestReconnectReturnsToTmux(t *testing.T) {
	fs := newFakeServer(t)
	a, p := testApp(t, fs)
	s := newSession(a, p, "secret", 80, 24)
	if err := s.connect(startScript("", "")); err != nil {
		t.Fatal(err)
	}
	s.setState(stateConnected, "")
	go s.run()
	defer s.close()

	waitFor(t, "tty marker", func() bool { _, tty, pid, _ := s.snapshot(); return tty == "/dev/pts/9" && pid == "4321" })
	info, err := s.info()
	if err != nil {
		t.Fatal(err)
	}
	if info.Tmux != "main" || info.Cwd != "/home/test/project" {
		t.Fatalf("info = %+v", info)
	}

	// Network drop: server kills the TCP connection.
	fs.dropAll()
	waitFor(t, "reconnect", func() bool { st, _, _, _ := s.snapshot(); return fs.startCount() == 2 && st == stateConnected })
	fs.mu.Lock()
	second := fs.starts[1]
	fs.mu.Unlock()
	if !strings.Contains(second, "tmux attach-session -t '=main'") {
		t.Fatalf("reconnect did not re-attach tmux: %s", second)
	}
	if !strings.Contains(second, `exec "${SHELL:-/bin/sh}" -l`) {
		t.Fatalf("no shell fallback: %s", second)
	}
}

func TestKeepaliveTimeoutTriggersReconnect(t *testing.T) {
	fs := newFakeServer(t)
	a, p := testApp(t, fs)
	s := newSession(a, p, "secret", 80, 24)
	if err := s.connect(startScript("", "")); err != nil {
		t.Fatal(err)
	}
	s.setState(stateConnected, "")
	go s.run()
	defer s.close()
	waitFor(t, "first start", func() bool { return fs.startCount() == 1 })

	// Server goes silent (half-dead connection): keepalives get no answer.
	fs.mu.Lock()
	fs.freeze = true
	fs.mu.Unlock()
	waitFor(t, "reconnecting state", func() bool { st, _, _, _ := s.snapshot(); return st == stateReconnecting || fs.startCount() > 1 })
	fs.mu.Lock()
	fs.freeze = false
	fs.mu.Unlock()
	waitFor(t, "reconnected", func() bool { st, _, _, _ := s.snapshot(); return fs.startCount() >= 2 && st == stateConnected })
}

func TestCleanExitDoesNotReconnect(t *testing.T) {
	fs := newFakeServer(t)
	a, p := testApp(t, fs)
	s := newSession(a, p, "secret", 80, 24)
	if err := s.connect(startScript("", "")); err != nil {
		t.Fatal(err)
	}
	s.setState(stateConnected, "")
	go s.run()
	defer s.close()
	s.write([]byte("exit\r"))
	waitFor(t, "exited", func() bool { st, _, _, _ := s.snapshot(); return st == stateExited })
	time.Sleep(300 * time.Millisecond)
	if fs.startCount() != 1 {
		t.Fatalf("reconnected after clean exit")
	}
}

func TestSFTPOperations(t *testing.T) {
	fs := newFakeServer(t)
	a, p := testApp(t, fs)
	s := newSession(a, p, "secret", 80, 24)
	if err := s.connect(startScript("", "")); err != nil {
		t.Fatal(err)
	}
	s.setState(stateConnected, "")
	defer s.close()

	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(s.mkdir("/work"))
	must(s.createFile("/work/a.txt"))
	if err := s.createFile("/work/a.txt"); err == nil {
		t.Fatal("creating an existing file should fail")
	}
	must(s.rename("/work/a.txt", "/work/b.txt"))
	ls, err := s.listDir("/work")
	must(err)
	if len(ls.Entries) != 1 || ls.Entries[0].Name != "b.txt" {
		t.Fatalf("listing = %+v", ls)
	}

	// Upload a local folder, then download it back.
	local := t.TempDir()
	src := filepath.Join(local, "proj")
	os.MkdirAll(filepath.Join(src, "sub"), 0o755)
	payload := strings.Repeat("hello world ", 50000)
	os.WriteFile(filepath.Join(src, "sub", "big.txt"), []byte(payload), 0o644)
	os.WriteFile(filepath.Join(src, "top.txt"), []byte("top"), 0o644)
	a.upload(s, []string{src}, "/work")
	waitFor(t, "upload", func() bool { a.xferMu.Lock(); defer a.xferMu.Unlock(); return len(a.xfers) == 0 })
	ls, err = s.listDir("/work/proj/sub")
	must(err)
	if len(ls.Entries) != 1 || ls.Entries[0].Size != int64(len(payload)) {
		t.Fatalf("uploaded listing = %+v", ls)
	}

	dl := t.TempDir()
	time.Sleep(50 * time.Millisecond)
	a.download(s, []string{"/work/proj"}, dl)
	waitFor(t, "download", func() bool { a.xferMu.Lock(); defer a.xferMu.Unlock(); return len(a.xfers) == 0 })
	got, err := os.ReadFile(filepath.Join(dl, "proj", "sub", "big.txt"))
	must(err)
	if string(got) != payload {
		t.Fatalf("downloaded content mismatch (%d bytes)", len(got))
	}

	must(s.remove([]string{"/work/proj", "/work/b.txt"}))
	ls, err = s.listDir("/work")
	must(err)
	if len(ls.Entries) != 0 {
		t.Fatalf("after delete = %+v", ls)
	}
}

func TestConfigRoundTripAndSecret(t *testing.T) {
	path := filepath.Join(t.TempDir(), configFileName)
	cfg, err := loadConfig(path) // creates defaults
	if err != nil {
		t.Fatal(err)
	}
	enc, err := encryptSecret("p@ss'word")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(enc, "p@ss") {
		t.Fatal("password stored in clear text")
	}
	cfg.Profiles = append(cfg.Profiles, Profile{ID: "x", Name: "srv", Host: "h", Port: 22, User: "u", Password: enc})
	if err := saveConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	cfg2, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	pw, err := decryptSecret(cfg2.Profiles[0].Password)
	if err != nil || pw != "p@ss'word" {
		t.Fatalf("decrypt = %q, %v", pw, err)
	}
	if cfg2.Settings.Keys["new_tab"] != "Ctrl+Shift+T" {
		t.Fatal("default keys missing")
	}
}
