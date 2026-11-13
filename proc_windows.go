//go:build windows

package main

import (
	"os/exec"
	"strconv"
	"syscall"
)

const createNoWindow = 0x08000000

// hideWindow keeps child CLIs from flashing a console window.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

// killTree stops the process and its children (npm shims start node underneath).
func killTree(cmd *exec.Cmd) {
	kill := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid))
	hideWindow(kill)
	if kill.Run() != nil {
		cmd.Process.Kill()
	}
}
