package main

// Integration tests against an in-process fake SSH server: login, tty marker,
// tmux tracking, auto-reconnect into the same tmux session, keepalive timeout,
// and SFTP file operations / transfers.

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/pem"
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
	t          *testing.T
	ln         net.Listener
	cfg        *ssh.ServerConfig
	pub        ssh.PublicKey
	mu         sync.Mutex
	conns      []net.Conn
	starts     []string // start scripts received
	freeze     bool     // stop answering keepalives
	sftpRoot   sftp.Handlers
	authorized ssh.PublicKey // accepted client key (authorized_keys)
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
	fs.cfg.PublicKeyCallback = func(c ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
		fs.mu.Lock()
		defer fs.mu.Unlock()
		if fs.authorized != nil && c.User() == "u" && string(key.Marshal()) == string(fs.authorized.Marshal()) {
			return nil, nil
		}
		return nil, io.EOF
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
				io.WriteString(ch, "/dev/pts/9|main|opencode|/home/test/project\n/dev/pts/2|other|bash|/tmp\n@@\n/home/test\n@@\nbash\n")
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
	if info.Tmux != "main" || info.Cwd != "/home/test/project" || info.Cmd != "opencode" {
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

func writeKey(t *testing.T, passphrase string) (path string, pub ssh.PublicKey) {
	t.Helper()
	pk, priv, _ := ed25519.GenerateKey(rand.Reader)
	var block *pem.Block
	var err error
	if passphrase == "" {
		block, err = ssh.MarshalPrivateKey(priv, "test")
	} else {
		block, err = ssh.MarshalPrivateKeyWithPassphrase(priv, "test", []byte(passphrase))
	}
	if err != nil {
		t.Fatal(err)
	}
	path = filepath.Join(t.TempDir(), "id_ed25519")
	os.WriteFile(path, pem.EncodeToMemory(block), 0o600)
	pub, _ = ssh.NewPublicKey(pk)
	return path, pub
}

func TestKeyLogin(t *testing.T) {
	fs := newFakeServer(t)
	a, p := testApp(t, fs)
	p.AuthType = "key"

	// Unencrypted key accepted by the server.
	path, pub := writeKey(t, "")
	fs.mu.Lock()
	fs.authorized = pub
	fs.mu.Unlock()
	p.KeyPath = path
	s := newSession(a, p, "", 80, 24)
	if err := s.connect(startScript("", "")); err != nil {
		t.Fatalf("plain key: %v", err)
	}
	s.close()

	// Encrypted key: no passphrase → asks for it; wrong → auth error; right → ok.
	encPath, encPub := writeKey(t, "kunci rahasia")
	fs.mu.Lock()
	fs.authorized = encPub
	fs.mu.Unlock()
	p.KeyPath = encPath
	if err := newSession(a, p, "", 80, 24).connect(startScript("", "")); !isAuthError(err) || !strings.Contains(authMessage(p, err), "passphrase") {
		t.Fatalf("missing passphrase: %v", err)
	}
	if err := newSession(a, p, "salah", 80, 24).connect(startScript("", "")); !isAuthError(err) || !strings.Contains(authMessage(p, err), "salah") {
		t.Fatalf("wrong passphrase: %v", err)
	}
	s = newSession(a, p, "kunci rahasia", 80, 24)
	if err := s.connect(startScript("", "")); err != nil {
		t.Fatalf("encrypted key: %v", err)
	}
	s.close()

	// Key not in authorized_keys → rejected with a helpful message.
	p.KeyPath = path
	err := newSession(a, p, "", 80, 24).connect(startScript("", ""))
	if !isAuthError(err) || !strings.Contains(authMessage(p, err), "authorized_keys") {
		t.Fatalf("unauthorized key: %v", err)
	}

	// Wrong file types give clear errors.
	pubFile := filepath.Join(t.TempDir(), "id.pub")
	os.WriteFile(pubFile, ssh.MarshalAuthorizedKey(pub), 0o600)
	if _, err := loadKey(pubFile, ""); err == nil || !strings.Contains(err.Error(), "public key") {
		t.Fatalf("pub file: %v", err)
	}
	ppk := filepath.Join(t.TempDir(), "id.ppk")
	os.WriteFile(ppk, []byte("PuTTY-User-Key-File-3: ssh-ed25519\n"), 0o600)
	if _, err := loadKey(ppk, ""); err == nil || !strings.Contains(err.Error(), "PuTTY") {
		t.Fatalf("ppk file: %v", err)
	}
}

func TestEditorReadSaveConflict(t *testing.T) {
	fs := newFakeServer(t)
	a, p := testApp(t, fs)
	s := newSession(a, p, "secret", 80, 24)
	if err := s.connect(startScript("", "")); err != nil {
		t.Fatal(err)
	}
	s.setState(stateConnected, "")
	defer s.close()
	c, _ := s.getSFTP()
	w := func(path, content string) {
		f, err := c.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
		if err != nil {
			t.Fatal(err)
		}
		f.Write([]byte(content))
		f.Close()
	}
	w("/app.py", "print('hi')\r\n")
	ef, err := s.readForEdit("/app.py")
	if err != nil || ef.Content != "print('hi')\r\n" {
		t.Fatalf("read: %+v %v", ef, err)
	}
	mod, err := s.saveFromEdit("/app.py", "print('hello')\r\n", ef.Stamp, false)
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	ef2, _ := s.readForEdit("/app.py")
	if ef2.Content != "print('hello')\r\n" {
		t.Fatalf("content after save: %q", ef2.Content)
	}
	// Someone else changes the file → saving with the old timestamp is a conflict.
	// (The in-memory test server only sets mtime on create, so recreate the file.)
	time.Sleep(20 * time.Millisecond)
	c.Remove("/app.py")
	w("/app.py", "changed elsewhere")
	if _, err := s.saveFromEdit("/app.py", "mine", mod, false); err == nil || !strings.HasPrefix(err.Error(), "conflict:") {
		t.Fatalf("want conflict, got %v", err)
	}
	if _, err := s.saveFromEdit("/app.py", "mine", mod, true); err != nil {
		t.Fatalf("forced save: %v", err)
	}
	// Binary files are refused.
	w("/bin.dat", "ab\x00cd")
	if _, err := s.readForEdit("/bin.dat"); err == nil || !strings.Contains(err.Error(), "biner") {
		t.Fatalf("binary: %v", err)
	}
}
