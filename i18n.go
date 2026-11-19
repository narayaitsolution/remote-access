package main

import (
	"os"
	"strings"
	"sync/atomic"
)

// The UI language: "id" (Indonesian) or "en" (English). The setting
// `language` in config.toml is "" (follow Windows), "id" or "en"; it is applied
// at start-up, so a change takes effect after the app is reopened.
var uiLang atomic.Value

// resolveLang turns the setting into the language actually used.
func resolveLang(setting string) string {
	switch setting {
	case "id", "en":
		return setting
	}
	return systemLang()
}

func setUILang(setting string) { uiLang.Store(resolveLang(setting)) }

// curLang is the language in use; Indonesian until start-up sets it (tests).
func curLang() string {
	if v, ok := uiLang.Load().(string); ok {
		return v
	}
	return "id"
}

// L returns the Indonesian or the English text for the current UI language.
func L(id, en string) string {
	if curLang() == "en" {
		return en
	}
	return id
}

// langFromLocale maps a locale name such as "id-ID" or "en_US.UTF-8".
func langFromLocale(s string) string {
	s = strings.ToLower(s)
	if s == "id" || strings.HasPrefix(s, "id-") || strings.HasPrefix(s, "id_") || strings.HasPrefix(s, "in-") || strings.HasPrefix(s, "in_") {
		return "id"
	}
	return "en"
}

func envLang() string {
	for _, k := range []string{"LC_ALL", "LC_MESSAGES", "LANG"} {
		if v := os.Getenv(k); v != "" {
			return langFromLocale(v)
		}
	}
	return "en"
}
