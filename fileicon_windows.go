//go:build windows

package main

// File-type icons taken from Windows itself (the icon of the application
// associated with each extension), the same ones Explorer shows.

import (
	"bytes"
	"errors"
	"image"
	"image/png"
	"syscall"
	"unsafe"
)

var (
	shell32            = syscall.NewLazyDLL("shell32.dll")
	user32             = syscall.NewLazyDLL("user32.dll")
	gdi32              = syscall.NewLazyDLL("gdi32.dll")
	procSHGetFileInfoW = shell32.NewProc("SHGetFileInfoW")
	procDestroyIcon    = user32.NewProc("DestroyIcon")
	procGetIconInfo    = user32.NewProc("GetIconInfo")
	procGetDC          = user32.NewProc("GetDC")
	procReleaseDC      = user32.NewProc("ReleaseDC")
	procGetObjectW     = gdi32.NewProc("GetObjectW")
	procGetDIBits      = gdi32.NewProc("GetDIBits")
	procDeleteObject   = gdi32.NewProc("DeleteObject")
)

const (
	shgfiIcon              = 0x100
	shgfiLargeIcon         = 0x0 // 32x32, shown at 16px for sharpness on HiDPI
	shgfiUseFileAttributes = 0x10
	fileAttributeNormal    = 0x80
	fileAttributeDirectory = 0x10
)

type shFileInfo struct {
	hIcon         uintptr
	iIcon         int32
	dwAttributes  uint32
	szDisplayName [260]uint16
	szTypeName    [80]uint16
}

type iconInfo struct {
	fIcon    int32
	xHotspot uint32
	yHotspot uint32
	hbmMask  uintptr
	hbmColor uintptr
}

type bitmapObj struct {
	bmType       int32
	bmWidth      int32
	bmHeight     int32
	bmWidthBytes int32
	bmPlanes     uint16
	bmBitsPixel  uint16
	bmBits       uintptr
}

type bitmapInfoHeader struct {
	biSize          uint32
	biWidth         int32
	biHeight        int32
	biPlanes        uint16
	biBitCount      uint16
	biCompression   uint32
	biSizeImage     uint32
	biXPelsPerMeter int32
	biYPelsPerMeter int32
	biClrUsed       uint32
	biClrImportant  uint32
}

// shellIconPNG returns the Explorer icon for a file extension (".pdf"),
// or for folders when ext is "<dir>", as PNG bytes.
func shellIconPNG(ext string) ([]byte, error) {
	name, attr := "file"+ext, uint32(fileAttributeNormal)
	if ext == "<dir>" {
		name, attr = "folder", fileAttributeDirectory
	}
	p, _ := syscall.UTF16PtrFromString(name)
	var fi shFileInfo
	r, _, _ := procSHGetFileInfoW.Call(uintptr(unsafe.Pointer(p)), uintptr(attr), uintptr(unsafe.Pointer(&fi)),
		unsafe.Sizeof(fi), shgfiIcon|shgfiLargeIcon|shgfiUseFileAttributes)
	if r == 0 || fi.hIcon == 0 {
		return nil, errors.New("no icon")
	}
	defer procDestroyIcon.Call(fi.hIcon)
	img, err := iconToImage(fi.hIcon)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func bitmapPixels(hdc, hbm uintptr) (w, h int, px []byte, err error) {
	var bm bitmapObj
	if r, _, _ := procGetObjectW.Call(hbm, unsafe.Sizeof(bm), uintptr(unsafe.Pointer(&bm))); r == 0 {
		return 0, 0, nil, errors.New("GetObject failed")
	}
	w, h = int(bm.bmWidth), int(bm.bmHeight)
	bi := bitmapInfoHeader{biSize: uint32(unsafe.Sizeof(bitmapInfoHeader{})), biWidth: int32(w), biHeight: -int32(h), biPlanes: 1, biBitCount: 32}
	px = make([]byte, w*h*4)
	if r, _, _ := procGetDIBits.Call(hdc, hbm, 0, uintptr(h), uintptr(unsafe.Pointer(&px[0])), uintptr(unsafe.Pointer(&bi)), 0); r == 0 {
		return 0, 0, nil, errors.New("GetDIBits failed")
	}
	return w, h, px, nil
}

func iconToImage(hIcon uintptr) (image.Image, error) {
	var ii iconInfo
	if r, _, _ := procGetIconInfo.Call(hIcon, uintptr(unsafe.Pointer(&ii))); r == 0 {
		return nil, errors.New("GetIconInfo failed")
	}
	defer procDeleteObject.Call(ii.hbmMask)
	defer procDeleteObject.Call(ii.hbmColor)
	if ii.hbmColor == 0 {
		return nil, errors.New("monochrome icon")
	}
	hdc, _, _ := procGetDC.Call(0)
	defer procReleaseDC.Call(0, hdc)
	w, h, px, err := bitmapPixels(hdc, ii.hbmColor)
	if err != nil {
		return nil, err
	}
	hasAlpha := false
	for i := 3; i < len(px); i += 4 {
		if px[i] != 0 {
			hasAlpha = true
			break
		}
	}
	var mask []byte
	if !hasAlpha { // old-style icon: transparency comes from the AND mask
		if _, _, m, err := bitmapPixels(hdc, ii.hbmMask); err == nil && len(m) >= len(px) {
			mask = m
		}
	}
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < w*h; i++ {
		b, g, r, a := px[i*4], px[i*4+1], px[i*4+2], px[i*4+3]
		if !hasAlpha {
			a = 255
			if mask != nil && mask[i*4] != 0 {
				a = 0
			}
		}
		img.Pix[i*4], img.Pix[i*4+1], img.Pix[i*4+2], img.Pix[i*4+3] = r, g, b, a
	}
	return img, nil
}
