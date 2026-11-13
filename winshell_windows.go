//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var (
	shlwapi             = syscall.NewLazyDLL("shlwapi.dll")
	procAssocQueryStr   = shlwapi.NewProc("AssocQueryStringW")
	assocStrFriendlyApp = uintptr(4)
	assocStrExecutable  = uintptr(2)
)

func assocQuery(ext string, what uintptr) string {
	if ext == "" {
		return ""
	}
	pExt, _ := syscall.UTF16PtrFromString(ext)
	pVerb, _ := syscall.UTF16PtrFromString("open")
	var n uint32 = 1024
	buf := make([]uint16, n)
	r, _, _ := procAssocQueryStr.Call(0, what, uintptr(unsafe.Pointer(pExt)), uintptr(unsafe.Pointer(pVerb)),
		uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&n)))
	if r != 0 {
		return ""
	}
	return syscall.UTF16ToString(buf)
}

// associatedApp returns the friendly name of the program that opens ext, or "".
func associatedApp(ext string) string {
	exe := assocQuery(ext, assocStrExecutable)
	if exe == "" || strings.Contains(strings.ToLower(exe), "openwith.exe") {
		return ""
	}
	if _, err := os.Stat(exe); err != nil && filepath.IsAbs(exe) {
		return ""
	}
	if name := assocQuery(ext, assocStrFriendlyApp); name != "" {
		return name
	}
	return filepath.Base(exe)
}

// shellOpen opens a file with its associated program, like double-clicking it.
func shellOpen(file string) error {
	verb, _ := syscall.UTF16PtrFromString("open")
	f, _ := syscall.UTF16PtrFromString(file)
	return windows.ShellExecute(0, verb, f, nil, nil, windows.SW_SHOWNORMAL)
}

// refreshPath reloads PATH from the registry so programs installed while the
// app runs (winget, npm) are found without restarting it.
func refreshPath() {
	read := func(root registry.Key, key string) string {
		k, err := registry.OpenKey(root, key, registry.QUERY_VALUE)
		if err != nil {
			return ""
		}
		defer k.Close()
		v, _, err := k.GetStringValue("Path")
		if err != nil {
			return ""
		}
		if exp, err := registry.ExpandString(v); err == nil {
			return exp
		}
		return v
	}
	parts := []string{
		read(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Control\Session Manager\Environment`),
		read(registry.CURRENT_USER, `Environment`),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Microsoft", "WinGet", "Links"),
		os.Getenv("PATH"),
	}
	seen := map[string]bool{}
	var out []string
	for _, p := range parts {
		for _, d := range strings.Split(p, ";") {
			key := strings.ToLower(strings.TrimRight(d, `\`))
			if d != "" && !seen[key] {
				seen[key] = true
				out = append(out, d)
			}
		}
	}
	os.Setenv("PATH", strings.Join(out, ";"))
}
