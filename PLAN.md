# Rencana Kerja: Remote Terminal (pengganti MobaXterm)

## Tujuan
Aplikasi Windows 10 berupa **satu file .exe portable** (tanpa instalasi) untuk:
- Remote SSH ke server Ubuntu (yang memakai tmux) dengan layar terminal semaksimal mungkin.
- Transfer & manajemen file via **SFTP** (lewat koneksi SSH yang sama).
- Tahan terhadap koneksi tidak stabil.

## Keputusan yang sudah disepakati
| Hal | Keputusan |
|---|---|
| Login | Username + password |
| Simpan password | Opsional per profil. Jika disimpan → **dienkripsi** (Windows DPAPI, terikat akun Windows). Jika tidak → ditanya setiap konek. |
| Konfigurasi | File teks (`config.toml`) di folder yang sama dengan .exe |
| Transfer file | SFTP saja (ikut SSH), tanpa FTPS terpisah |
| Reconnect | Otomatis & senyap, langsung kembali ke **sesi tmux terakhir** yang sedang dipakai; jika gagal (tmux tidak ada / sesi hilang) → tetap login ke shell biasa |
| Sidebar | Bisa show/hide; **default mengikuti direktori kerja terminal**; user tetap bisa navigasi sendiri (mode ikut dimatikan sementara, ada tombol untuk kembali mengikuti) |

## Teknologi
- **Go** — library SSH & SFTP yang matang (`golang.org/x/crypto/ssh`, `github.com/pkg/sftp`), hasil build satu .exe.
- **Wails v2** — UI berbasis WebView2 (sudah terpasang di Windows 10 Anda), tetap satu .exe (~15 MB).
- **xterm.js** — terminal emulator yang sama dipakai VS Code; cepat (render WebGL), dukungan warna & tmux penuh.

## Perilaku kunci (jawaban atas keluhan di MobaXterm)
- **Scroll langsung tanpa Shift:** roda mouse dikirim ke tmux sebagai event scroll (tmux `mouse on`), sehingga history tmux langsung tergulir. Di luar tmux, scroll memakai scrollback lokal.
- **Blok = langsung tersalin:** drag mouse selalu menjadi seleksi lokal (tidak dikirim ke tmux) dan otomatis disalin ke clipboard Windows. Klik kanan = paste.
- **Shortcut sesi** (pakai Ctrl+Shift agar tidak bentrok dengan Ctrl+W/Ctrl+T di bash/tmux; semua bisa diubah di `config.toml`):
  - `Ctrl+Shift+T` sesi baru di tab baru
  - `Ctrl+Shift+E` sesi baru di split **vertikal** (kiri | kanan)
  - `Ctrl+Shift+O` sesi baru di split **horizontal** (atas / bawah)
  - Setiap sesi baru (tab maupun split) dibuka dengan **halaman pemilihan server** seperti halaman depan
  - `Ctrl+Shift+W` tutup sesi/pane aktif · `Alt+Panah` pindah fokus antar pane
  - `Ctrl+Tab` / `Ctrl+Shift+Tab` pindah tab · `Ctrl+1..9` langsung ke tab ke-N
  - `F11` layar penuh · `Ctrl+Shift+B` tampil/sembunyikan sidebar (bukan `Ctrl+B` karena itu prefix tmux)
- **Stabilitas:** keepalive SSH tiap 15 detik + TCP keepalive (penyebab utama putus di cmd adalah tidak adanya keepalive), deteksi putus, reconnect otomatis dengan jeda bertahap, lalu attach ke sesi tmux semula.
- **Keamanan:** verifikasi host key (simpan ke `known_hosts` di folder aplikasi, peringatan jika berubah).

## Tahapan

### Tahap 0 — Persiapan
- Install Go dan Wails CLI, buat kerangka proyek, pastikan build menghasilkan satu .exe yang bisa jalan.
- **Hasil:** jendela kosong dari .exe tunggal.

### Tahap 1 — Terminal SSH dasar
- Koneksi SSH dengan password (host/user di-hardcode sementara), xterm.js, resize mengikuti jendela, keepalive.
- **Hasil:** bisa login dan menjalankan tmux dengan tampilan benar.

### Tahap 2 — Profil server & konfigurasi
- `config.toml`: daftar profil (nama, host, port, user, password terenkripsi opsional, nama sesi tmux, folder awal).
- Halaman depan: daftar profil (cari, tambah, edit, hapus, duplikat), double-click untuk konek.
- Dialog password jika tidak disimpan, dengan centang "simpan password".
- **Hasil:** alur seperti halaman depan MobaXterm.

### Tahap 3 — Multi-sesi & split
- Tab sesi, shortcut di atas, indikator status tiap tab (terhubung / reconnect / putus).
- Split vertikal/horizontal di dalam tab (bisa bertingkat), batas antar pane bisa di-drag, pane baru menampilkan pemilih server.
- Sidebar mengikuti pane yang sedang fokus.
- Mode layar maksimal: tab bar tipis, sidebar bisa disembunyikan, F11 fullscreen.
- **Hasil:** buka/tutup banyak server dengan cepat.

### Tahap 4 — Mouse & clipboard
- Scroll tanpa Shift (integrasi tmux mouse), seleksi lokal + auto-copy, klik kanan paste, paste multi-baris aman.
- Pengaturan font & ukuran (Ctrl+scroll / Ctrl+= untuk zoom).
- **Hasil:** keluhan scroll & copy di MobaXterm teratasi.

### Tahap 5 — Ketahanan koneksi
- Selama terhubung, aplikasi mencatat sesi tmux yang sedang dipakai di tab itu (lewat channel SSH terpisah: `tmux list-clients` dicocokkan dengan TTY tab).
- Deteksi putus → layar terminal tetap tampil (tidak dikosongkan), indikator kecil "menyambung ulang…", reconnect dengan jeda bertahap (memakai password tersimpan/di-cache selama aplikasi terbuka).
- Setelah tersambung: `tmux attach -t <sesi terakhir>`. Jika tmux tidak ada atau sesi sudah hilang → tampilkan shell biasa saja, user masuk ke tmux sendiri.
- Ketikan selama putus tidak dikirim ke tempat yang salah (ditahan/dibuang dengan pemberitahuan).
- Uji dengan memutus Wi-Fi / sleep laptop.
- **Hasil:** koneksi pulih sendiri dan user kembali ke tempat yang sama tanpa merasa terputus.

### Tahap 6 — Sidebar SFTP
- Panel kiri: daftar file (nama, ukuran, tanggal, izin), path bar yang bisa diketik, tombol up/home/refresh, bookmark folder per profil.
- Show/hide sidebar (`Ctrl+Shift+B` + tombol), lebar bisa diatur dengan drag.
- **Default ikut direktori kerja terminal**, tanpa perlu mengubah `.bashrc`:
  - Di dalam tmux: baca `#{pane_current_path}` dari pane aktif (via channel SSH terpisah, dicek saat terminal idle/setelah Enter).
  - Di luar tmux: baca `/proc/<pid shell>/cwd`.
- Saat user navigasi sendiri di sidebar, mode ikut otomatis berhenti sementara; tombol "ikuti terminal" untuk kembali.
- Upload/download dengan progress bar & antrian, bisa dibatalkan.
- **Hasil:** quick navigation + transfer file seperti MobaXterm.

### Tahap 7 — Manajemen file, menu klik kanan & drag-and-drop
- **Toolbar di sidebar (selalu ada, tidak bergantung drag & drop):** satu baris **ikon kecil** di bagian atas sidebar (tanpa teks, keterangan muncul saat mouse diarahkan/tooltip) agar hemat tempat:
  `Up (folder sebelumnya)` · `Upload` · `Download` · `File baru` · `Folder baru` · `Rename` · `Hapus` · `Refresh` · `Ikuti terminal`
  Di bawahnya: path bar satu baris yang bisa diketik.
- **Menu klik kanan** pada file/folder: Download, Rename, Hapus, Salin path, chmod, Buka di terminal (`cd` ke sana). Klik kanan di area kosong: Upload, File baru, Folder baru, Refresh.
- Shortcut keyboard di sidebar: `F2` rename, `Del` hapus (dengan konfirmasi), `Enter` buka folder, `Backspace` naik satu folder.
- Pilih banyak file sekaligus (Ctrl/Shift+klik) untuk download/hapus massal.
- Drag file/folder dari Windows Explorer ke sidebar → upload.
- Drag dari sidebar ke Explorer → download (perlu kode native Windows; jika terkendala, cukup tombol/menu Download ke folder pilihan).
- **Hasil:** manajemen file visual lengkap.

### Tahap 8 — Penyempurnaan & rilis
- Tema terang/gelap, ikon, simpan ukuran/posisi jendela, log error.
- Build final satu .exe, panduan singkat (README).

## Status (2026-11-13)
| Tahap | Status |
|---|---|
| 0 Persiapan | ✅ Go 1.27 + Wails 2.17, build → `build\bin\RemoteTerminal.exe` (13 MB) |
| 1 Terminal SSH | ✅ |
| 2 Profil & config | ✅ `config.toml` di samping .exe, password DPAPI |
| 3 Tab & split | ✅ |
| 4 Mouse & clipboard | ✅ perlu diuji dengan tmux sungguhan |
| 5 Reconnect | ✅ teruji otomatis (fake SSH server); perlu diuji di jaringan nyata |
| 6 Sidebar SFTP | ✅ |
| 7 Manajemen file | ✅ kecuali drag dari sidebar ke Explorer (pakai tombol/menu Download) |
| 8 Rilis | ⏳ menunggu uji coba di server nyata, ikon, lisensi |
