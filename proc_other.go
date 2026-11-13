//go:build !windows

package main

import "os/exec"

func hideWindow(cmd *exec.Cmd) {}

func killTree(cmd *exec.Cmd) { cmd.Process.Kill() }
