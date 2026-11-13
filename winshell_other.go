//go:build !windows

package main

import (
	"os/exec"
	"runtime"
)

func associatedApp(ext string) string {
	if ext == "" {
		return ""
	}
	return "default application"
}

func shellOpen(file string) error {
	if runtime.GOOS == "darwin" {
		return exec.Command("open", file).Start()
	}
	return exec.Command("xdg-open", file).Start()
}

func refreshPath() {}
