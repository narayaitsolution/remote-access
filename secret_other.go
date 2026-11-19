//go:build !windows

package main

import "errors"

// Password storage is only implemented on Windows (DPAPI).
func encryptSecret(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	return "", errors.New(L("menyimpan password hanya didukung di Windows", "saving passwords is only supported on Windows"))
}

func decryptSecret(stored string) (string, error) {
	if stored == "" {
		return "", nil
	}
	return "", errors.New(L("menyimpan password hanya didukung di Windows", "saving passwords is only supported on Windows"))
}
