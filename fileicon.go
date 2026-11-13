package main

import (
	"encoding/base64"
	"strings"
	"sync"
)

var fileIconCache = struct {
	sync.Mutex
	m map[string]string
}{m: map[string]string{}}

// FileIcons returns data URLs of the Windows icons for the given extensions
// (".pdf", ".docx", … or "<dir>" for folders). Unknown ones are left out, so
// the UI falls back to its own icons.
func (a *App) FileIcons(exts []string) map[string]string {
	out := map[string]string{}
	for _, ext := range exts {
		ext = strings.ToLower(ext)
		if len(ext) > 20 {
			continue
		}
		fileIconCache.Lock()
		url, ok := fileIconCache.m[ext]
		fileIconCache.Unlock()
		if !ok {
			if png, err := shellIconPNG(ext); err == nil {
				url = "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
			}
			fileIconCache.Lock()
			fileIconCache.m[ext] = url
			fileIconCache.Unlock()
		}
		if url != "" {
			out[ext] = url
		}
	}
	return out
}
