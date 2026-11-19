package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/ssh"
)

// authMethods returns how to log in for a profile. For password profiles,
// secret is the password; for key profiles it is the key passphrase (may be empty).
func authMethods(p Profile, secret string) ([]ssh.AuthMethod, error) {
	if p.authType() == "key" {
		signer, err := loadKey(p.KeyPath, secret)
		if err != nil {
			return nil, err
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, nil
	}
	return []ssh.AuthMethod{
		ssh.Password(secret),
		ssh.KeyboardInteractive(func(name, instr string, qs []string, echos []bool) ([]string, error) {
			ans := make([]string, len(qs))
			for i := range qs {
				if !echos[i] {
					ans[i] = secret
				}
			}
			return ans, nil
		}),
	}, nil
}

// loadKey reads an OpenSSH/PEM private key, decrypting it with passphrase if needed.
func loadKey(path, passphrase string) (ssh.Signer, error) {
	path = expandHome(strings.TrimSpace(path))
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf(L("tidak bisa membaca private key %s: %w", "cannot read private key %s: %w"), path, err)
	}
	if strings.HasPrefix(string(data), "PuTTY-User-Key-File") {
		return nil, errors.New(L("format PuTTY (.ppk) belum didukung. Buka key di PuTTYgen lalu pilih Conversions → Export OpenSSH key", "PuTTY format (.ppk) is not supported yet. Open the key in PuTTYgen and choose Conversions → Export OpenSSH key"))
	}
	if strings.HasPrefix(strings.TrimSpace(string(data)), "ssh-") {
		return nil, errors.New(L("file ini adalah public key (.pub). Pilih file private key-nya (tanpa .pub)", "this file is a public key (.pub). Choose its private key file (without .pub)"))
	}
	signer, err := ssh.ParsePrivateKey(data)
	var missing *ssh.PassphraseMissingError
	if errors.As(err, &missing) {
		if passphrase == "" {
			return nil, &authError{L("Key ini terenkripsi. Masukkan passphrase-nya.", "This key is encrypted. Enter its passphrase.")}
		}
		signer, err = ssh.ParsePrivateKeyWithPassphrase(data, []byte(passphrase))
		if err != nil {
			return nil, &authError{L("Passphrase key salah.", "Wrong key passphrase.")}
		}
		return signer, nil
	}
	if err != nil {
		return nil, fmt.Errorf(L("private key tidak valid: %w", "invalid private key: %w"), err)
	}
	return signer, nil
}

func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, p[1:])
		}
	}
	return p
}
