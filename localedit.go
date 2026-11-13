package main

// "Edit with a Windows application": the remote file is copied to a temp
// folder and opened with its associated program (e.g. Word, Excel, LibreOffice).
// Every time it is saved there, it is uploaded back to the server.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sync"
	"time"
)

type LocalEdit struct {
	ID       string `json:"id"`
	Session  string `json:"sessId"`
	Remote   string `json:"remote"`
	Name     string `json:"name"`
	App      string `json:"app"`   // program that opens it
	State    string `json:"state"` // editing | syncing | synced | error | closed
	Error    string `json:"error"`
	LastSync int64  `json:"lastSync"` // unix seconds
	local    string
	dir      string
	cancel   context.CancelFunc
}

var localEdits = struct {
	sync.Mutex
	m map[string]*LocalEdit
}{m: map[string]*LocalEdit{}}

func (a *App) emitLocalEdit(e *LocalEdit) {
	localEdits.Lock()
	snap := *e
	localEdits.Unlock()
	snap.cancel = nil
	a.emit("localEdit", snap)
}

// AppForFile returns the Windows program that opens files with this name's
// extension, or "" when none is installed.
func (a *App) AppForFile(name string) string {
	return associatedApp(filepath.Ext(name))
}

// EditLocally downloads a remote file, opens it with its Windows application
// and uploads it back whenever it is saved.
func (a *App) EditLocally(id, remote string) (LocalEdit, error) {
	s, err := a.session(id)
	if err != nil {
		return LocalEdit{}, err
	}
	app := associatedApp(path.Ext(remote))
	if app == "" {
		return LocalEdit{}, fmt.Errorf("noapp:Tidak ada aplikasi di Windows untuk membuka file %s", path.Ext(remote))
	}
	data, err := s.readBinary(remote)
	if err != nil {
		return LocalEdit{}, err
	}
	dir := filepath.Join(os.TempDir(), "remote-terminal-edit", newID())
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return LocalEdit{}, err
	}
	local := filepath.Join(dir, sanitizeLocal(path.Base(remote)))
	if err := os.WriteFile(local, data, 0o600); err != nil {
		return LocalEdit{}, err
	}
	if err := shellOpen(local); err != nil {
		os.RemoveAll(dir)
		return LocalEdit{}, fmt.Errorf("gagal membuka %s: %w", filepath.Base(local), err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	e := &LocalEdit{ID: newID(), Session: id, Remote: remote, Name: path.Base(remote), App: app,
		State: "editing", local: local, dir: dir, cancel: cancel}
	localEdits.Lock()
	localEdits.m[e.ID] = e
	localEdits.Unlock()
	a.emitLocalEdit(e)
	go a.watchLocal(ctx, e)
	return *e, nil
}

func (a *App) watchLocal(ctx context.Context, e *LocalEdit) {
	st, _ := os.Stat(e.local)
	last := st.ModTime()
	t := time.NewTicker(1500 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		st, err := os.Stat(e.local)
		if err != nil || !st.ModTime().After(last) {
			continue
		}
		// Wait until the program has finished writing (size/time stable).
		time.Sleep(1200 * time.Millisecond)
		st2, err := os.Stat(e.local)
		if err != nil || st2.ModTime() != st.ModTime() || st2.Size() != st.Size() {
			continue
		}
		last = st2.ModTime()
		a.syncLocal(e)
	}
}

func (a *App) syncLocal(e *LocalEdit) {
	localEdits.Lock()
	e.State, e.Error = "syncing", ""
	localEdits.Unlock()
	a.emitLocalEdit(e)
	err := func() error {
		s, err := a.session(e.Session)
		if err != nil {
			return errors.New("terminal untuk file ini sudah ditutup")
		}
		c, err := s.getSFTP()
		if err != nil {
			return err
		}
		return uploadFile(context.Background(), c, e.local, e.Remote, func(int64) {})
	}()
	localEdits.Lock()
	if err != nil {
		e.State, e.Error = "error", err.Error()
	} else {
		e.State, e.LastSync = "synced", time.Now().Unix()
	}
	localEdits.Unlock()
	a.emitLocalEdit(e)
}

// StopLocalEdit stops watching (after a last upload if needed) and removes the temp copy.
func (a *App) StopLocalEdit(id string) {
	localEdits.Lock()
	e := localEdits.m[id]
	delete(localEdits.m, id)
	localEdits.Unlock()
	if e == nil {
		return
	}
	e.cancel()
	e.State = "closed"
	a.emitLocalEdit(e)
	go func() {
		// The program may still hold the file open; try for a while.
		for i := 0; i < 20; i++ {
			if os.RemoveAll(e.dir) == nil {
				return
			}
			time.Sleep(3 * time.Second)
		}
	}()
}
