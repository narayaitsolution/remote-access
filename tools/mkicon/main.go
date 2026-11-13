// mkicon turns a large square PNG into the app icons used by the Windows build:
//
//	go run ./tools/mkicon <source.png>
//
// writes build/appicon.png (1024px) and build/windows/icon.ico (16–256px).
// Pass -preview <file.png> to also write a sheet with every size.
package main

import (
	"bytes"
	"encoding/binary"
	"flag"
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
)

var sizes = []int{16, 20, 24, 32, 40, 48, 64, 128, 256}

func main() {
	preview := flag.String("preview", "", "write a preview sheet of all sizes")
	flag.Parse()
	if flag.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "usage: go run ./tools/mkicon [-preview sheet.png] <source.png>")
		os.Exit(2)
	}
	f, err := os.Open(flag.Arg(0))
	check(err)
	src, err := png.Decode(f)
	f.Close()
	check(err)

	check(writePNG(filepath.Join("build", "appicon.png"), resize(src, 1024)))

	var imgs [][]byte
	for _, s := range sizes {
		var buf bytes.Buffer
		check(png.Encode(&buf, resize(src, s)))
		imgs = append(imgs, buf.Bytes())
	}
	check(os.WriteFile(filepath.Join("build", "windows", "icon.ico"), ico(imgs), 0o644))

	if *preview != "" {
		total := 0
		for _, s := range sizes {
			total += s + 16
		}
		sheet := image.NewNRGBA(image.Rect(0, 0, total, 256+16))
		x := 8
		for _, s := range sizes {
			r := resize(src, s)
			for yy := 0; yy < s; yy++ {
				for xx := 0; xx < s; xx++ {
					sheet.Set(x+xx, 8+256-s+yy, r.At(xx, yy))
				}
			}
			x += s + 16
		}
		check(writePNG(*preview, sheet))
	}
	fmt.Println("wrote build/appicon.png and build/windows/icon.ico")
}

// resize scales down with an area-average (box) filter on premultiplied colour.
func resize(src image.Image, size int) *image.NRGBA {
	b := src.Bounds()
	dst := image.NewNRGBA(image.Rect(0, 0, size, size))
	sx, sy := float64(b.Dx())/float64(size), float64(b.Dy())/float64(size)
	for y := 0; y < size; y++ {
		y0, y1 := int(float64(y)*sy), int(float64(y+1)*sy)
		if y1 <= y0 {
			y1 = y0 + 1
		}
		for x := 0; x < size; x++ {
			x0, x1 := int(float64(x)*sx), int(float64(x+1)*sx)
			if x1 <= x0 {
				x1 = x0 + 1
			}
			var r, g, bl, a, n float64
			for yy := y0; yy < y1; yy++ {
				for xx := x0; xx < x1; xx++ {
					cr, cg, cb, ca := src.At(b.Min.X+xx, b.Min.Y+yy).RGBA() // premultiplied, 16-bit
					r, g, bl, a, n = r+float64(cr), g+float64(cg), bl+float64(cb), a+float64(ca), n+1
				}
			}
			i := dst.PixOffset(x, y)
			if a == 0 {
				continue
			}
			dst.Pix[i] = uint8(r / a * 255)
			dst.Pix[i+1] = uint8(g / a * 255)
			dst.Pix[i+2] = uint8(bl / a * 255)
			dst.Pix[i+3] = uint8(a / n / 257)
		}
	}
	return dst
}

// ico packs PNG images into a .ico file (PNG entries, supported since Windows Vista).
func ico(pngs [][]byte) []byte {
	var out bytes.Buffer
	binary.Write(&out, binary.LittleEndian, [3]uint16{0, 1, uint16(len(pngs))})
	offset := 6 + 16*len(pngs)
	for i, p := range pngs {
		s := sizes[i]
		dim := uint8(s)
		if s >= 256 {
			dim = 0 // 0 means 256
		}
		out.Write([]byte{dim, dim, 0, 0})
		binary.Write(&out, binary.LittleEndian, [2]uint16{1, 32})
		binary.Write(&out, binary.LittleEndian, [2]uint32{uint32(len(p)), uint32(offset)})
		offset += len(p)
	}
	for _, p := range pngs {
		out.Write(p)
	}
	return out.Bytes()
}

func writePNG(path string, img image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, img)
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
