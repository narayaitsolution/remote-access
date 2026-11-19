//go:build windows

package main

import "golang.org/x/sys/windows"

var procUILang = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetUserDefaultUILanguage")

// systemLang is the Windows display language: Indonesian or else English.
func systemLang() string {
	if procUILang.Find() == nil {
		if r, _, _ := procUILang.Call(); r != 0 {
			if r&0x3ff == 0x21 { // LANG_INDONESIAN
				return "id"
			}
			return "en"
		}
	}
	return envLang()
}
