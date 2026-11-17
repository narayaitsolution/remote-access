# Riwayat versi Remote Terminal

Fitur baru menaikkan angka utama (mis. 10.0 → 11.0); perbaikan dan perubahan kecil menaikkan angka di belakang titik (mis. 8.1 → 8.2).
Bagian setiap versi di file ini ditampilkan di jendela Informasi aplikasi dan di jendela update.

## 11.0
- **Blok & copy di semua terminal**: drag untuk memblok teks dan teks langsung tersalin, kini juga di terminal biasa (tanpa tmux), bukan hanya di tmux.
- **Klik mouse ke program di layar**: klik pada tab, tombol, dan menu program seperti opencode, htop, mc atau panel tmux kini sampai ke program tersebut. Drag atau klik ganda tetap memblok dan menyalin teks.
- **Progress upload/download per file**: setiap file punya bar progress sendiri, dengan keterangan file ke berapa dari berapa.
- **Jendela Informasi** (tombol ⓘ di bagian atas): versi aplikasi, daftar fitur, dan riwayat versi, dengan tombol *Cek update*.
- **Cek update otomatis** saat aplikasi dibuka (di latar belakang). Jika ada versi baru, ditampilkan fitur barunya dengan pilihan *Update* atau *Skip*. *Update* mengunduh `RemoteTerminal.exe` baru ke folder Download dan menjelaskan cara menggantinya tanpa menghapus data server.
- **Nama file tanpa versi**: aplikasi kini selalu bernama `RemoteTerminal.exe`, jadi update cukup dengan mengganti file; versinya terlihat di jendela Informasi.
- AI Sidebar: checkbox *Izinkan baca otomatis* dan *Izinkan ubah otomatis* dihapus karena sudah ada Mode Agen.

## 10.0
- **Mode Agen di AI Sidebar**: AI mengerjakan tugas sampai selesai langsung di layar — mencari file, membukanya di tab editor, mengedit (perubahan disorot), menguji, memperbaiki error (maksimal 5 kali), lalu melapor. Tugas besar bisa diserahkan ke opencode/Claude Code/Codex yang tampil di layar; jika layar sedang dipakai, AI membuka terminal baru di tab baru. Tindakan disetujui otomatis kecuali yang berisiko.
- **AI Companion**: saran kode abu-abu di editor seperti Copilot, diminta dengan `Alt+\` (hemat token), `Tab` untuk menerima. Bekerja dengan API OpenAI-compatible, Claude Code atau Codex.
- Tombol *AI* berganti nama menjadi *AI Sidebar*.

## 9.0
- Editor kode seperti VS Code untuk Python, PHP, Java, Go, C/C++, C#, Ruby, Rust, Kotlin, shell, SQL dan lainnya: autocomplete kata kunci, snippet dengan `Tab`, pilih bahasa di status bar (`Ctrl+K M`), *Format* (`Shift+Alt+F`), palet perintah (`F1`), word wrap (`Alt+Z`), sticky scroll dan folding.
- Minimap dihapus; pengaturan baru `editor_word_wrap` dan `editor_tab_size`.

## 8.4
- File `.exe` diterbitkan di GitHub Releases dan dibangun otomatis oleh GitHub Actions; tes berjalan di setiap push.

## 8.3
- Ikon aplikasi baru.

## 8.2
- Ikon file di sidebar SFTP sama dengan Windows Explorer (sesuai program yang membukanya).

## 8.1
- Perbaikan kotak abu-abu yang menutupi judul tab pertama.

## 8.0
- Penampil PDF, Markdown (preview/edit) dan gambar.
- Edit Word/Excel/PowerPoint di aplikasi Windows dengan upload otomatis setiap disimpan; *Buka dengan aplikasi Windows* untuk semua file.
- Cek program pendukung saat pertama kali dibuka, dengan instalasi satu klik lewat winget (Claude Code, Codex, LibreOffice) dan tombol *Login*.

## 7.0
- Provider AI lewat URL OpenAI-compatible + API key (OpenAI, OpenRouter, Groq, DeepSeek, Ollama, LM Studio…), model tampil di panel AI, API key disimpan terenkripsi.

## 6.0
- Editor file bawaan (Monaco, seperti VS Code): nomor baris, warna sintaks, simpan dengan `Ctrl+S`, peringatan perubahan yang belum disimpan, deteksi konflik.

## 5.1
- AI tidak mengetik ke layar pengguna kecuali diminta; tool baru untuk menjalankan perintah di latar belakang.

## 5.0
- AI berfungsi sebagai chat biasa; setiap akses server butuh izin (baca/ubah); AI bisa mengendalikan program di layar (mis. opencode di tmux); tool pemantau layar.

## 4.0
- Asisten AI memakai Claude Code / Codex yang terpasang: membaca layar, menjalankan perintah, mengirim tombol, membaca/menulis file; persetujuan; pilihan model; pemakaian dan batas.

## 3.1
- Dokumentasi login dengan SSH key.

## 3.0
- Login dengan SSH private key (OpenSSH/PEM, dengan passphrase).

## 2.1
- Teks yang dipotong program sesuai lebar layar disambung kembali saat disalin.

## 2.0
- Notifikasi di pojok kanan atas untuk copy dan setiap aksi file.

## 1.2
- Copy banyak baris memakai baris baru Windows dan membuang spasi pengisi; lisensi MIT.

## 1.1
- README lengkap.

## 1.0
- Rilis pertama: terminal SSH portable, daftar server, tab dan split, sambung ulang otomatis ke tmux, blok untuk copy, sidebar SFTP yang mengikuti folder terminal, upload/download, kelola file, drag & drop.
