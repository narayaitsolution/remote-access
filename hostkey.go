package main

import (
	"bufio"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func (a *App) knownHostsPath() string {
	return filepath.Join(a.dir, "known_hosts")
}

// knownHostAlgorithms prefers the key type we already trust for this host,
// so a server with several key types does not trigger a false "changed" warning.
func (a *App) knownHostAlgorithms(addr string) []string {
	path := a.knownHostsPath()
	kh, err := knownhosts.New(path)
	if err != nil {
		return nil
	}
	var algos []string
	// Probe with a dummy key: the KeyError lists the keys we know for this host.
	err = kh(addr, &net.TCPAddr{}, dummyKey{})
	var ke *knownhosts.KeyError
	if errors.As(err, &ke) {
		for _, k := range ke.Want {
			switch k.Key.Type() {
			case ssh.KeyAlgoRSA:
				algos = append(algos, ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256, ssh.KeyAlgoRSA)
			default:
				algos = append(algos, k.Key.Type())
			}
		}
	}
	return algos
}

type dummyKey struct{}

func (dummyKey) Type() string                        { return "dummy" }
func (dummyKey) Marshal() []byte                     { return []byte("dummy") }
func (dummyKey) Verify([]byte, *ssh.Signature) error { return errors.New("dummy") }

type hostKeyPrompt struct {
	ReqID       string `json:"reqId"`
	Host        string `json:"host"`
	KeyType     string `json:"keyType"`
	Fingerprint string `json:"fingerprint"`
	Changed     bool   `json:"changed"`
}

func (a *App) hostKeyCallback() ssh.HostKeyCallback {
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		path := a.knownHostsPath()
		if _, err := os.Stat(path); os.IsNotExist(err) {
			os.WriteFile(path, nil, 0o600)
		}
		kh, err := knownhosts.New(path)
		if err != nil {
			return err
		}
		err = kh(hostname, remote, key)
		if err == nil {
			return nil
		}
		var ke *knownhosts.KeyError
		if !errors.As(err, &ke) {
			return err
		}
		changed := len(ke.Want) > 0
		ok := a.askHostKey(hostKeyPrompt{
			Host: hostname, KeyType: key.Type(), Fingerprint: ssh.FingerprintSHA256(key), Changed: changed,
		})
		if !ok {
			return errors.New("host key ditolak")
		}
		a.hostMu.Lock()
		defer a.hostMu.Unlock()
		norm := knownhosts.Normalize(hostname)
		if changed {
			removeKnownHost(path, norm)
		}
		f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0o600)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = f.WriteString(knownhosts.Line([]string{norm}, key) + "\n")
		return err
	}
}

func removeKnownHost(path, host string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var out []string
	sc := bufio.NewScanner(strings.NewReader(string(data)))
	for sc.Scan() {
		line := sc.Text()
		fields := strings.Fields(line)
		if len(fields) > 0 {
			hosts := strings.Split(fields[0], ",")
			match := false
			for _, h := range hosts {
				if h == host {
					match = true
				}
			}
			if match {
				continue
			}
		}
		out = append(out, line)
	}
	os.WriteFile(path, []byte(strings.Join(out, "\n")+"\n"), 0o600)
}

// askHostKey shows a dialog in the UI and waits for the answer.
func (a *App) askHostKey(p hostKeyPrompt) bool {
	p.ReqID = newID()
	ch := make(chan bool, 1)
	a.hostMu.Lock()
	a.hostWait[p.ReqID] = ch
	a.hostMu.Unlock()
	defer func() {
		a.hostMu.Lock()
		delete(a.hostWait, p.ReqID)
		a.hostMu.Unlock()
	}()
	a.emit("hostkey", p)
	select {
	case ok := <-ch:
		return ok
	case <-time.After(4 * time.Minute):
		return false
	}
}
