//go:build !windows

package main

import "errors"

func shellIconPNG(ext string) ([]byte, error) { return nil, errors.New("not supported") }
