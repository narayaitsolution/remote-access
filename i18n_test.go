package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Every t('…') text in the UI must have an English translation in i18n-en.ts.
func TestUITextsHaveEnglish(t *testing.T) {
	en, err := os.ReadFile(filepath.Join("frontend", "src", "i18n-en.ts"))
	if err != nil {
		t.Fatal(err)
	}
	call := regexp.MustCompile(`\bt(?:In)?\((?:[a-z]+, )?'((?:[^'\\n]|\.)*)'`)
	files, _ := filepath.Glob(filepath.Join("frontend", "src", "*.ts"))
	n := 0
	for _, f := range files {
		if strings.HasSuffix(f, "i18n-en.ts") {
			continue
		}
		src, _ := os.ReadFile(f)
		for _, m := range call.FindAllStringSubmatch(string(src), -1) {
			n++
			if !strings.Contains(string(en), "\n  '"+m[1]+"': ") {
				t.Errorf("%s: no English text for '%s'", filepath.Base(f), m[1])
			}
		}
	}
	if n < 100 {
		t.Errorf("only %d t() calls found; is the pattern still right?", n)
	}
}

func TestLangFromLocale(t *testing.T) {
	for in, want := range map[string]string{"id-ID": "id", "id": "id", "in_ID.UTF-8": "id", "en-US": "en", "nl-NL": "en", "": "en"} {
		if got := langFromLocale(in); got != want {
			t.Errorf("langFromLocale(%q) = %q, want %q", in, got, want)
		}
	}
	if resolveLang("en") != "en" || resolveLang("id") != "id" {
		t.Error("explicit language not kept")
	}
}
