// Information window (version, features, version history) and the update
// check: in the background at start-up (silent when there is nothing new or
// GitHub cannot be reached) and on demand from the Information window.
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { CheckUpdate, DownloadUpdate, GetAppLocation, GetChangelog, GetVersion, OpenLocalFolder } from '../wailsjs/go/main/App';
import { BrowserOpenURL, EventsOn } from '../wailsjs/runtime/runtime';
import { saveSettingsSoon, store } from './state';
import { errMsg, h, isModalOpen, openModal, toast } from './ui';

const RELEASES_URL = 'https://github.com/narayaitsolution/remote-access/releases';

/** What the app can do, grouped; "sejak" is the version that introduced it. */
const FEATURES: { title: string; items: [string, string][] }[] = [
  { title: 'Terminal SSH', items: [
    ['Satu file .exe portable tanpa instalasi; pengaturan di config.toml di samping .exe', '1.0'],
    ['Daftar server dengan pencarian; tambah, edit, duplikat, hapus, urutkan', '1.0'],
    ['Login dengan password (terenkripsi DPAPI Windows) atau SSH key (OpenSSH/PEM, dengan passphrase)', '3.0'],
    ['Sambung ulang otomatis saat jaringan putus, kembali ke sesi tmux yang sama', '1.0'],
    ['Tab dan split vertikal/horizontal; semua shortcut bisa diubah di config.toml', '1.0'],
    ['Drag untuk memblok dan otomatis copy, di terminal biasa maupun tmux; klik kanan untuk paste', '11.0'],
    ['Klik mouse sampai ke program di layar (tab dan tombol opencode, htop, panel tmux)', '11.0'],
    ['Teks yang dipotong sesuai lebar layar disambung kembali saat disalin', '2.1'],
  ] },
  { title: 'File (sidebar SFTP)', items: [
    ['Sidebar mengikuti folder terminal; ikon file sama dengan Windows Explorer', '8.2'],
    ['Upload/download dengan tombol atau drag & drop, progress per file', '11.0'],
    ['File baru, folder baru, rename, hapus, chmod, salin path', '1.0'],
    ['Notifikasi untuk setiap copy dan aksi file', '2.0'],
  ] },
  { title: 'Editor kode (seperti VS Code)', items: [
    ['Buka file server di tab editor: warna sintaks untuk 80+ bahasa, Ctrl+S menyimpan, deteksi konflik', '6.0'],
    ['Autocomplete dan snippet (Tab), pilih bahasa (Ctrl+K M), Format (Shift+Alt+F), palet perintah (F1), word wrap (Alt+Z)', '9.0'],
    ['AI Companion: saran kode abu-abu seperti Copilot, diminta dengan Alt+\\ (hemat token)', '10.0'],
    ['Penampil PDF, Markdown dan gambar; edit Word/Excel/PowerPoint di aplikasi Windows dengan upload otomatis', '8.0'],
  ] },
  { title: 'AI Sidebar', items: [
    ['Chat AI memakai Claude Code, Codex, atau API OpenAI-compatible (OpenRouter, Groq, DeepSeek, Ollama…)', '4.0'],
    ['AI membaca layar, menjalankan perintah, membaca/menulis file — selalu dengan izin Anda', '5.0'],
    ['Mode Agen: AI mengerjakan tugas langsung di layar sampai selesai (cari, edit, uji, perbaiki, lapor); tindakan berisiko tetap ditanyakan', '10.0'],
  ] },
  { title: 'Lainnya', items: [
    ['Cek program pendukung dan instalasi satu klik lewat winget', '8.0'],
    ['Cek update otomatis saat aplikasi dibuka, dan jendela Informasi ini', '11.0'],
  ] },
];

const md = (s: string) => DOMPurify.sanitize(marked.parse(s, { async: false, gfm: true }) as string);

function links(el: HTMLElement) {
  for (const a of el.querySelectorAll('a')) {
    a.addEventListener('click', e => { e.preventDefault(); const href = a.getAttribute('href'); if (href?.startsWith('https://')) BrowserOpenURL(href); });
  }
}

/** The Information window. */
export async function showAbout() {
  const version = await GetVersion();
  const checkBtn = h('button', { class: 'btn' }, 'Cek update');
  const checkMsg = h('span', { class: 'about-check muted' });
  checkBtn.onclick = async () => {
    checkBtn.disabled = true;
    checkMsg.textContent = 'Memeriksa…';
    try {
      const u = await CheckUpdate();
      if (u.available) { checkMsg.textContent = ''; closeAbout(); await offerUpdate(u, true); }
      else checkMsg.textContent = `Sudah versi terbaru (${u.current}).`;
    } catch (e) {
      checkMsg.textContent = 'Tidak bisa memeriksa update: ' + errMsg(e);
    } finally {
      checkBtn.disabled = false;
    }
  };
  const features = h('div', { class: 'about-features' }, ...FEATURES.map(g =>
    h('div', { class: 'about-group' }, h('div', { class: 'about-group-title' }, g.title),
      h('ul', {}, ...g.items.map(([text, since]) => h('li', {}, text, ' ', h('span', { class: 'about-since', title: `Sejak versi ${since}` }, `v${since}`)))))));
  const history = h('div', { class: 'about-history modal-text' });
  history.innerHTML = md((await GetChangelog()).replace(/^# .*\n/, ''));
  links(history);
  const body = h('div', { class: 'about' },
    h('div', { class: 'about-head' },
      h('div', {},
        h('div', { class: 'about-name' }, 'Remote Terminal'),
        h('div', { class: 'about-version' }, `Versi ${version}`)),
      h('span', { class: 'ed-spacer' }),
      checkMsg, checkBtn),
    h('div', { class: 'about-section' }, 'Fitur'),
    features,
    h('details', { class: 'about-details' }, h('summary', {}, 'Riwayat versi'), history),
    h('div', { class: 'about-foot muted' }, 'Rilis dan unduhan: ',
      h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); BrowserOpenURL(RELEASES_URL); } }, 'GitHub Releases')));
  let closeAbout = () => {};
  const p = openModal('Informasi', body, [{ label: 'Tutup', value: 'close', primary: true }], undefined, 'center wide');
  closeAbout = () => body.closest('.modal-overlay')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await p;
}

interface UpdateInfo {
  current: string; latest: string; available: boolean; assetUrl: string; assetName: string; size: number; pageUrl: string;
  notes: { version: string; date: string; notes: string }[];
}

/** Shows what is new and offers Update / Skip. */
async function offerUpdate(u: UpdateInfo, manual: boolean) {
  const notes = h('div', { class: 'update-notes modal-text' });
  notes.innerHTML = u.notes.map(n =>
    `<h4>Versi ${n.version}${n.date ? ` <span class="muted">(${n.date})</span>` : ''}</h4>${md(n.notes || 'Lihat halaman rilis.')}`).join('');
  links(notes);
  const body = h('div', {},
    h('div', { class: 'modal-text' }, `Versi baru tersedia: `, h('b', {}, u.latest), ` (Anda memakai ${u.current}). Yang baru:`),
    notes);
  const r = await openModal('Update tersedia', body, [
    { label: manual ? 'Nanti' : 'Skip', value: 'skip' },
    { label: 'Update', value: 'update', primary: true },
  ], undefined, 'center wide');
  if (r === 'update') { await downloadUpdate(u); return; }
  if (r === 'skip' && !manual) {
    store.settings.skipUpdate = u.latest; // not offered again at start-up until a newer one
    saveSettingsSoon();
  }
}

async function downloadUpdate(u: UpdateInfo) {
  const fill = h('div', { class: 'xfer-fill', style: 'width:0%' });
  const label = h('div', { class: 'muted' }, 'Mengunduh…');
  const overlay = h('div', { class: 'modal-overlay' },
    h('div', { class: 'modal center' }, h('div', { class: 'modal-title' }, `Mengunduh Remote Terminal ${u.latest}`),
      h('div', { class: 'xfer-bar update-bar' }, fill), label));
  document.body.append(overlay);
  const off = EventsOn('update:progress', (p: { done: number; total: number }) => {
    const total = p.total > 0 ? p.total : u.size;
    const pct = total > 0 ? Math.min(100, Math.floor(p.done / total * 100)) : 0;
    fill.style.width = pct + '%';
    label.textContent = `${(p.done / 1048576).toFixed(1)} MB${total > 0 ? ` dari ${(total / 1048576).toFixed(1)} MB` : ''}`;
  });
  let path = '';
  try {
    path = await DownloadUpdate(u.assetUrl);
  } catch (e) {
    toast('Update gagal diunduh: ' + errMsg(e), 'error');
    return;
  } finally {
    off();
    overlay.remove();
  }
  await showInstallSteps(u.latest, path);
}

/** Explains how to replace the old .exe without losing the saved servers. */
async function showInstallSteps(version: string, path: string) {
  const loc = await GetAppLocation();
  const dlDir = path.replace(/[\\/][^\\/]*$/, '');
  const newName = path.split(/[\\/]/).pop() || 'RemoteTerminal.exe';
  const oldName = loc.exePath.split(/[\\/]/).pop() || 'RemoteTerminal.exe';
  const configHere = loc.configPath.toLowerCase().startsWith(loc.exeDir.toLowerCase() + '\\');
  const code = (s: string) => h('code', {}, s);
  const body = h('div', { class: 'modal-text install-steps' },
    h('p', {}, `Remote Terminal ${version} sudah diunduh ke `, code(path), '.'),
    h('ol', {},
      h('li', {}, 'Tutup Remote Terminal ini (semua jendelanya).'),
      h('li', {}, 'Pindahkan ', code(newName), ' dari folder Download ke folder aplikasi ', code(loc.exeDir),
        ...(newName !== 'RemoteTerminal.exe' ? [' dan beri nama ', code('RemoteTerminal.exe')] : []),
        '. Jika Windows bertanya, pilih ', h('b', {}, 'Ganti file (Replace)'), '.'),
      oldName.toLowerCase() !== 'remoteterminal.exe'
        ? h('li', {}, 'File lama ', code(oldName), ' boleh dihapus setelah file baru dipindahkan — hanya file .exe itu saja.')
        : null,
      h('li', { class: 'warn-step' }, h('b', {}, 'Jangan hapus '), code('config.toml'), ' dan ', code('known_hosts'),
        configHere ? ' di folder aplikasi' : '', ': daftar server, password terenkripsi, dan pengaturan Anda tersimpan di sana',
        ...(configHere ? ['.'] : [' (', code(loc.configPath), ').'])),
      h('li', {}, 'Jalankan ', code('RemoteTerminal.exe'), ' yang baru. Versinya bisa dicek lewat tombol ⓘ (Informasi).')),
    h('div', { class: 'install-btns' },
      h('button', { class: 'btn', onclick: () => OpenLocalFolder(dlDir) }, 'Buka folder Download'),
      h('button', { class: 'btn', onclick: () => OpenLocalFolder(loc.exeDir) }, 'Buka folder aplikasi')));
  await openModal('Update siap dipasang', body, [{ label: 'Mengerti', value: 'ok', primary: true }], undefined, 'center wide');
}

/** Background check at start-up: shows nothing unless there is a new version. */
export function checkUpdateAtStartup() {
  setTimeout(async () => {
    let u: UpdateInfo;
    try { u = await CheckUpdate() as unknown as UpdateInfo; } catch { return; } // offline / GitHub unreachable: stay quiet
    if (!u.available || u.latest === store.settings.skipUpdate) return;
    // Don't stack on top of another dialog (e.g. the first-run check).
    for (let i = 0; i < 300 && isModalOpen(); i++) await new Promise(r => setTimeout(r, 2000));
    await offerUpdate(u, false);
  }, 5000);
}
