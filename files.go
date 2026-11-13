package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/pkg/sftp"
)

type FileEntry struct {
	Name    string `json:"name"`
	Size    int64  `json:"size"`
	Mode    string `json:"mode"`
	ModTime int64  `json:"modTime"` // unix seconds
	IsDir   bool   `json:"isDir"`
	IsLink  bool   `json:"isLink"`
}

type DirListing struct {
	Path    string      `json:"path"`
	Entries []FileEntry `json:"entries"`
}

func (s *Session) listDir(p string) (DirListing, error) {
	c, err := s.getSFTP()
	if err != nil {
		return DirListing{}, err
	}
	if p == "" || p == "~" {
		if p, err = c.Getwd(); err != nil {
			return DirListing{}, err
		}
	} else if strings.HasPrefix(p, "~/") {
		home, _ := c.Getwd()
		p = path.Join(home, p[2:])
	}
	if rp, err := c.RealPath(p); err == nil {
		p = rp
	}
	infos, err := c.ReadDir(p)
	if err != nil {
		return DirListing{}, err
	}
	entries := make([]FileEntry, 0, len(infos))
	for _, fi := range infos {
		e := FileEntry{Name: fi.Name(), Size: fi.Size(), Mode: fi.Mode().String(),
			ModTime: fi.ModTime().Unix(), IsDir: fi.IsDir(), IsLink: fi.Mode()&fs.ModeSymlink != 0}
		if e.IsLink {
			if st, err := c.Stat(path.Join(p, fi.Name())); err == nil {
				e.IsDir = st.IsDir()
			}
		}
		entries = append(entries, e)
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	return DirListing{Path: p, Entries: entries}, nil
}

func (s *Session) mkdir(p string) error {
	c, err := s.getSFTP()
	if err != nil {
		return err
	}
	return c.Mkdir(p)
}

func (s *Session) createFile(p string) error {
	c, err := s.getSFTP()
	if err != nil {
		return err
	}
	f, err := c.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
	if err != nil {
		return err
	}
	return f.Close()
}

func (s *Session) rename(from, to string) error {
	c, err := s.getSFTP()
	if err != nil {
		return err
	}
	if _, err := c.Lstat(to); err == nil {
		return fmt.Errorf("%s sudah ada", path.Base(to))
	}
	return c.Rename(from, to)
}

func (s *Session) remove(paths []string) error {
	c, err := s.getSFTP()
	if err != nil {
		return err
	}
	for _, p := range paths {
		if p == "" || p == "/" {
			continue
		}
		st, err := c.Lstat(p)
		if err != nil {
			return err
		}
		if st.IsDir() {
			err = c.RemoveAll(p)
		} else {
			err = c.Remove(p)
		}
		if err != nil {
			return fmt.Errorf("%s: %w", path.Base(p), err)
		}
	}
	return nil
}

func (s *Session) chmod(p, mode string) error {
	c, err := s.getSFTP()
	if err != nil {
		return err
	}
	m, err := strconv.ParseUint(strings.TrimSpace(mode), 8, 32)
	if err != nil || m > 0o7777 {
		return errors.New("mode harus angka oktal, contoh 755")
	}
	return c.Chmod(p, os.FileMode(m))
}

// ---------- transfers ----------

type TransferInfo struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"` // "upload" | "download"
	Name  string `json:"name"`
	Total int64  `json:"total"`
	Done  int64  `json:"done"`
	State string `json:"state"` // running | done | error | cancelled
	Error string `json:"error"`
	Dir   string `json:"dir"` // remote dir (upload) or local dir (download)
	Sess  string `json:"sessId"`
}

type Transfer struct {
	TransferInfo
	cancel context.CancelFunc
	mu     sync.Mutex
	last   time.Time
}

func (a *App) newTransfer(sess, kind, name, dir string) (*Transfer, context.Context) {
	ctx, cancel := context.WithCancel(context.Background())
	t := &Transfer{TransferInfo: TransferInfo{ID: newID(), Kind: kind, Name: name, Dir: dir, Sess: sess, State: "running"}, cancel: cancel}
	a.xferMu.Lock()
	a.xfers[t.ID] = t
	a.xferMu.Unlock()
	return t, ctx
}

func (a *App) emitTransfer(t *Transfer, force bool) {
	t.mu.Lock()
	if !force && time.Since(t.last) < 200*time.Millisecond {
		t.mu.Unlock()
		return
	}
	t.last = time.Now()
	snap := t.TransferInfo
	t.mu.Unlock()
	a.emit("xfer", snap)
}

func (a *App) finishTransfer(t *Transfer, ctx context.Context, err error) {
	t.mu.Lock()
	switch {
	case ctx.Err() != nil:
		t.State = "cancelled"
	case err != nil:
		t.State, t.Error = "error", err.Error()
	default:
		t.State = "done"
	}
	t.mu.Unlock()
	a.emitTransfer(t, true)
	a.xferMu.Lock()
	delete(a.xfers, t.ID)
	a.xferMu.Unlock()
}

func (t *Transfer) add(n int64) {
	t.mu.Lock()
	t.Done += n
	t.mu.Unlock()
}

type progressReader struct {
	ctx context.Context
	r   io.Reader
	fn  func(int64)
}

func (p *progressReader) Read(b []byte) (int, error) {
	if err := p.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := p.r.Read(b)
	p.fn(int64(n))
	return n, err
}

type progressWriter struct {
	ctx context.Context
	w   io.Writer
	fn  func(int64)
}

func (p *progressWriter) Write(b []byte) (int, error) {
	if err := p.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := p.w.Write(b)
	p.fn(int64(n))
	return n, err
}

func (a *App) upload(s *Session, locals []string, remoteDir string) {
	if len(locals) == 0 {
		return
	}
	name := filepath.Base(locals[0])
	if len(locals) > 1 {
		name = fmt.Sprintf("%s +%d lainnya", name, len(locals)-1)
	}
	t, ctx := a.newTransfer(s.ID, "upload", name, remoteDir)
	go func() {
		err := func() error {
			c, err := s.getSFTP()
			if err != nil {
				return err
			}
			for _, l := range locals { // total size first
				filepath.WalkDir(l, func(_ string, d fs.DirEntry, err error) error {
					if err == nil && !d.IsDir() {
						if fi, err := d.Info(); err == nil {
							t.Total += fi.Size()
						}
					}
					return nil
				})
			}
			a.emitTransfer(t, true)
			prog := func(n int64) { t.add(n); a.emitTransfer(t, false) }
			for _, l := range locals {
				base := filepath.Dir(l)
				err := filepath.WalkDir(l, func(lp string, d fs.DirEntry, err error) error {
					if err != nil {
						return err
					}
					if ctx.Err() != nil {
						return ctx.Err()
					}
					rel, _ := filepath.Rel(base, lp)
					rp := path.Join(remoteDir, filepath.ToSlash(rel))
					if d.IsDir() {
						return c.MkdirAll(rp)
					}
					return uploadFile(ctx, c, lp, rp, prog)
				})
				if err != nil {
					return err
				}
			}
			return nil
		}()
		a.finishTransfer(t, ctx, err)
	}()
}

func uploadFile(ctx context.Context, c *sftp.Client, local, remote string, prog func(int64)) error {
	src, err := os.Open(local)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := c.OpenFile(remote, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		return fmt.Errorf("%s: %w", path.Base(remote), err)
	}
	_, err = dst.ReadFromWithConcurrency(&progressReader{ctx, src, prog}, 0)
	if cerr := dst.Close(); err == nil {
		err = cerr
	}
	return err
}

func (a *App) download(s *Session, remotes []string, localDir string) {
	if len(remotes) == 0 {
		return
	}
	name := path.Base(remotes[0])
	if len(remotes) > 1 {
		name = fmt.Sprintf("%s +%d lainnya", name, len(remotes)-1)
	}
	t, ctx := a.newTransfer(s.ID, "download", name, localDir)
	go func() {
		err := func() error {
			c, err := s.getSFTP()
			if err != nil {
				return err
			}
			for _, r := range remotes {
				w := c.Walk(r)
				for w.Step() {
					if w.Err() == nil && !w.Stat().IsDir() {
						t.Total += w.Stat().Size()
					}
				}
			}
			a.emitTransfer(t, true)
			prog := func(n int64) { t.add(n); a.emitTransfer(t, false) }
			for _, r := range remotes {
				base := path.Dir(r)
				w := c.Walk(r)
				for w.Step() {
					if err := w.Err(); err != nil {
						return err
					}
					if ctx.Err() != nil {
						return ctx.Err()
					}
					rel := strings.TrimPrefix(strings.TrimPrefix(w.Path(), base), "/")
					lp := filepath.Join(localDir, filepath.FromSlash(sanitizeLocal(rel)))
					if w.Stat().IsDir() {
						if err := os.MkdirAll(lp, 0o755); err != nil {
							return err
						}
						continue
					}
					if err := downloadFile(ctx, c, w.Path(), lp, prog); err != nil {
						return err
					}
				}
			}
			return nil
		}()
		a.finishTransfer(t, ctx, err)
	}()
}

// sanitizeLocal replaces characters Windows does not allow in file names.
func sanitizeLocal(p string) string {
	r := strings.NewReplacer(":", "_", "*", "_", "?", "_", "\"", "_", "<", "_", ">", "_", "|", "_", "\\", "_")
	parts := strings.Split(p, "/")
	for i, s := range parts {
		parts[i] = r.Replace(s)
	}
	return strings.Join(parts, "/")
}

func downloadFile(ctx context.Context, c *sftp.Client, remote, local string, prog func(int64)) error {
	src, err := c.Open(remote)
	if err != nil {
		return fmt.Errorf("%s: %w", path.Base(remote), err)
	}
	defer src.Close()
	if err := os.MkdirAll(filepath.Dir(local), 0o755); err != nil {
		return err
	}
	dst, err := os.Create(local)
	if err != nil {
		return err
	}
	_, err = src.WriteTo(&progressWriter{ctx, dst, prog})
	if cerr := dst.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(local)
	}
	return err
}

// ---------- editor ----------

const maxEditBytes = 5 << 20

type EditFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Stamp   string `json:"stamp"` // modification time + size, used to detect outside changes
	Size    int64  `json:"size"`
	Mode    string `json:"mode"`
}

// fileStamp fingerprints a file version. SFTP reports times in whole seconds,
// so the size is included to catch changes within the same second.
func fileStamp(fi os.FileInfo) string {
	return fmt.Sprintf("%d:%d", fi.ModTime().Unix(), fi.Size())
}

func (s *Session) readForEdit(p string) (EditFile, error) {
	c, err := s.getSFTP()
	if err != nil {
		return EditFile{}, err
	}
	st, err := c.Stat(p)
	if err != nil {
		return EditFile{}, err
	}
	if st.IsDir() {
		return EditFile{}, errors.New("ini folder, bukan file")
	}
	if st.Size() > maxEditBytes {
		return EditFile{}, fmt.Errorf("file terlalu besar untuk editor (%d MB, maks 5 MB). Gunakan Download", st.Size()>>20)
	}
	f, err := c.Open(p)
	if err != nil {
		return EditFile{}, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxEditBytes+1))
	if err != nil {
		return EditFile{}, err
	}
	if looksBinary(data) {
		return EditFile{}, errors.New("file biner (bukan teks), tidak bisa dibuka di editor. Gunakan Download")
	}
	return EditFile{Path: p, Content: string(data), Stamp: fileStamp(st), Size: st.Size(), Mode: st.Mode().String()}, nil
}

// looksBinary reports NUL bytes or invalid UTF-8 in the first 8 KB.
func looksBinary(b []byte) bool {
	if len(b) > 8192 {
		b = b[:8192]
	}
	if bytes.IndexByte(b, 0) >= 0 {
		return true
	}
	// Allow a multi-byte character cut at the 8 KB boundary.
	for i := 0; i < 4 && len(b) > 0 && !utf8.Valid(b); i++ {
		b = b[:len(b)-1]
	}
	return !utf8.Valid(b)
}

// saveFromEdit writes content and returns the new stamp. If expect is set and
// the file changed on the server since it was opened, it fails with "conflict:"
// unless force is set.
func (s *Session) saveFromEdit(p, content, expect string, force bool) (string, error) {
	c, err := s.getSFTP()
	if err != nil {
		return "", err
	}
	if st, err := c.Stat(p); err == nil && expect != "" && !force && fileStamp(st) != expect {
		return "", fmt.Errorf("conflict:File di server sudah berubah sejak dibuka (terakhir diubah %s)", st.ModTime().Format("2006-01-02 15:04:05"))
	}
	f, err := c.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		return "", err
	}
	if _, err := io.WriteString(f, content); err != nil {
		f.Close()
		return "", err
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	st, err := c.Stat(p)
	if err != nil {
		return "", nil
	}
	return fileStamp(st), nil
}

const maxViewBytes = 64 << 20

// readBinary returns a remote file's bytes (for PDF / image viewers).
func (s *Session) readBinary(p string) ([]byte, error) {
	c, err := s.getSFTP()
	if err != nil {
		return nil, err
	}
	st, err := c.Stat(p)
	if err != nil {
		return nil, err
	}
	if st.Size() > maxViewBytes {
		return nil, fmt.Errorf("file terlalu besar untuk ditampilkan (%d MB, maks 64 MB). Gunakan Download", st.Size()>>20)
	}
	f, err := c.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, maxViewBytes))
}
