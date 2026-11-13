package main

import (
	"bytes"
	"encoding/json"
	"image"
	"image/draw"
	"image/png"
	"os"
	"runtime"
	"testing"
)

// Extracts the Windows icons of common file types. With RT_ICON_SHEET=<file>
// it also writes them side by side into one PNG for a visual check.
func TestFileIcons(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("windows only")
	}
	exts := []string{"<dir>", ".pdf", ".txt", ".md", ".docx", ".xlsx", ".pptx", ".png", ".zip", ".py", ".sh", ".log", ".json", ".unknownext"}
	sheet := image.NewNRGBA(image.Rect(0, 0, 36*len(exts), 36))
	for i, ext := range exts {
		b, err := shellIconPNG(ext)
		if err != nil {
			t.Fatalf("%s: %v", ext, err)
		}
		img, err := png.Decode(bytes.NewReader(b))
		if err != nil {
			t.Fatalf("%s: decode: %v", ext, err)
		}
		if img.Bounds().Dx() < 16 {
			t.Fatalf("%s: icon too small: %v", ext, img.Bounds())
		}
		draw.Draw(sheet, image.Rect(i*36+2, 2, i*36+34, 34), img, img.Bounds().Min, draw.Over)
	}
	if f := os.Getenv("RT_ICON_SHEET"); f != "" {
		out, _ := os.Create(f)
		png.Encode(out, sheet)
		out.Close()
	}
	if got := NewApp().FileIcons([]string{".PDF", ".pdf"}); len(got) != 1 {
		t.Fatalf("FileIcons = %d entries", len(got))
	}
}

// RT_ICON_JSON=<file> dumps FileIcons for common types (used for UI checks).
func TestDumpFileIcons(t *testing.T) {
	f := os.Getenv("RT_ICON_JSON")
	if f == "" {
		t.Skip("set RT_ICON_JSON")
	}
	m := NewApp().FileIcons([]string{"<dir>", ".pdf", ".txt", ".md", ".docx", ".xlsx", ".pptx", ".png", ".zip", ".py", ".sh", ".log", ".json", ".conf", ""})
	b, _ := json.Marshal(m)
	os.WriteFile(f, b, 0o644)
}
