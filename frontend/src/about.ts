// Information window (version, language, features, version history,
// donations) and the update check: in the background at start-up (silent when
// there is nothing new or GitHub cannot be reached) and on demand from the
// Information window.
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import {
  CheckUpdate, DownloadUpdate, GetAppLocation, GetChangelog, GetDonors, GetVersion, OpenLocalFolder, RestartApp, SaveSettings,
} from '../wailsjs/go/main/App';
import { main } from '../wailsjs/go/models';
import { BrowserOpenURL, EventsOn } from '../wailsjs/runtime/runtime';
import { getLang, t, tIn, type Lang } from './i18n';
import { hooks, saveSettingsSoon, store } from './state';
import { errMsg, h, isModalOpen, openModal, toast } from './ui';

const RELEASES_URL = 'https://github.com/narayaitsolution/remote-access/releases';

/** What the app can do, grouped: [Indonesian, English, version that introduced it]. */
const FEATURES: { title: [string, string]; items: [string, string, string][] }[] = [
  { title: ['Terminal SSH', 'SSH terminal'], items: [
    ['Satu file .exe portable tanpa instalasi; pengaturan di config.toml di samping .exe', 'One portable .exe, no installation; settings in config.toml next to the .exe', '1.0'],
    ['Daftar server dengan pencarian; tambah, edit, duplikat, hapus, urutkan', 'Server list with search; add, edit, duplicate, delete, reorder', '1.0'],
    ['Login dengan password (terenkripsi DPAPI Windows) atau SSH key (OpenSSH/PEM, dengan passphrase)', 'Log in with a password (encrypted with Windows DPAPI) or an SSH key (OpenSSH/PEM, with passphrase)', '3.0'],
    ['Sambung ulang otomatis saat jaringan putus, kembali ke sesi tmux yang sama', 'Automatic reconnect when the network drops, back into the same tmux session', '1.0'],
    ['Tab dan split vertikal/horizontal; semua shortcut bisa diubah di config.toml', 'Tabs and vertical/horizontal splits; every shortcut can be changed in config.toml', '1.0'],
    ['Drag untuk memblok dan otomatis copy, di terminal biasa maupun tmux; klik kanan untuk paste', 'Drag to select and copy automatically, in a plain shell or tmux; right-click to paste', '11.0'],
    ['Klik mouse sampai ke program di layar (tab dan tombol opencode, htop, panel tmux)', 'Mouse clicks reach programs on the screen (opencode tabs and buttons, htop, tmux panes)', '11.0'],
    ['Teks yang dipotong sesuai lebar layar disambung kembali saat disalin', 'Lines wrapped at the screen width are joined again when copied', '2.1'],
  ] },
  { title: ['File (sidebar SFTP)', 'Files (SFTP sidebar)'], items: [
    ['Sidebar mengikuti folder terminal; ikon file sama dengan Windows Explorer', 'The sidebar follows the terminal folder; file icons match Windows Explorer', '8.2'],
    ['Upload/download dengan tombol atau drag & drop, progress per file', 'Upload/download with buttons or drag & drop, progress per file', '11.0'],
    ['File baru, folder baru, rename, hapus, chmod, salin path', 'New file, new folder, rename, delete, chmod, copy path', '1.0'],
    ['Notifikasi untuk setiap copy dan aksi file', 'Notifications for every copy and file action', '2.0'],
  ] },
  { title: ['Editor kode (seperti VS Code)', 'Code editor (like VS Code)'], items: [
    ['Buka file server di tab editor: warna sintaks untuk 80+ bahasa, Ctrl+S menyimpan, deteksi konflik', 'Open server files in an editor tab: syntax colours for 80+ languages, Ctrl+S saves, conflict detection', '6.0'],
    ['Autocomplete dan snippet (Tab), pilih bahasa (Ctrl+K M), Format (Shift+Alt+F), palet perintah (F1), word wrap (Alt+Z)', 'Autocomplete and snippets (Tab), language mode (Ctrl+K M), Format (Shift+Alt+F), command palette (F1), word wrap (Alt+Z)', '9.0'],
    ['AI Companion: saran kode abu-abu seperti Copilot, diminta dengan Alt+\\ (hemat token)', 'AI Companion: grey code suggestions like Copilot, requested with Alt+\\ (saves tokens)', '10.0'],
    ['Penampil PDF, Markdown dan gambar; edit Word/Excel/PowerPoint di aplikasi Windows dengan upload otomatis', 'PDF, Markdown and image viewers; edit Word/Excel/PowerPoint in the Windows application with automatic upload', '8.0'],
  ] },
  { title: ['AI Sidebar', 'AI Sidebar'], items: [
    ['Chat AI memakai Claude Code, Codex, atau API OpenAI-compatible (OpenRouter, Groq, DeepSeek, Ollama…)', 'AI chat with Claude Code, Codex, or an OpenAI-compatible API (OpenRouter, Groq, DeepSeek, Ollama…)', '4.0'],
    ['AI membaca layar, menjalankan perintah, membaca/menulis file — selalu dengan izin Anda', 'The AI reads the screen, runs commands, reads/writes files — always with your permission', '5.0'],
    ['Mode Agen: AI mengerjakan tugas langsung di layar sampai selesai (cari, edit, uji, perbaiki, lapor); tindakan berisiko tetap ditanyakan', 'Agent mode: the AI does a task on the screen until it is done (find, edit, test, fix, report); risky actions are still asked', '10.0'],
  ] },
  { title: ['Lainnya', 'Other'], items: [
    ['Cek program pendukung dan instalasi satu klik lewat winget', 'Check of supporting programs and one-click installation with winget', '8.0'],
    ['Cek update otomatis saat aplikasi dibuka, dan jendela Informasi ini', 'Automatic update check at start-up, and this Information window', '11.0'],
    ['Bahasa Indonesia dan English (mengikuti bahasa Windows atau dipilih di sini)', 'Indonesian and English (follows the Windows language or chosen here)', '11.1'],
  ] },
];

const md = (s: string) => DOMPurify.sanitize(marked.parse(s, { async: false, gfm: true }) as string);

function links(el: HTMLElement) {
  for (const a of el.querySelectorAll('a')) {
    a.addEventListener('click', e => { e.preventDefault(); const href = a.getAttribute('href'); if (href?.startsWith('https://')) BrowserOpenURL(href); });
  }
}

/** Language picker: '' follows Windows. A change applies after a restart. */
function languagePicker(): HTMLElement {
  const sel = h('select', { class: 'about-lang', title: t('Bahasa aplikasi') },
    h('option', { value: '' }, t('Ikuti Windows')),
    h('option', { value: 'id' }, 'Bahasa Indonesia'),
    h('option', { value: 'en' }, 'English'));
  sel.value = store.settings.language || '';
  sel.onchange = async () => {
    store.settings.language = sel.value;
    try { await SaveSettings(main.Settings.createFrom(store.settings)); } catch (e) { toast(errMsg(e), 'error'); return; }
    // The language that will be used after the restart ('' = follows Windows, so unknown here: use the browser's).
    const next: Lang = (sel.value || (navigator.language.toLowerCase().startsWith('id') ? 'id' : 'en')) as Lang;
    if (next === getLang()) return; // nothing changes on screen
    const unsaved = hooks.allPanes().filter(p => p.editor?.dirty).length;
    const body = h('div', { class: 'modal-text' },
      tIn(next, 'Bahasa baru dipakai setelah aplikasi dibuka ulang.'), ' ',
      unsaved ? h('b', {}, tIn(next, 'Simpan dulu {0} file yang belum disimpan.', unsaved))
        : tIn(next, 'Membuka ulang sekarang akan menutup koneksi terminal yang sedang terbuka.'));
    const r = await openModal(tIn(next, 'Bahasa'), body, [
      { label: tIn(next, t('Nanti')), value: 'later' },
      ...(unsaved ? [] : [{ label: tIn(next, 'Buka ulang sekarang'), value: 'restart', primary: true }]),
    ]);
    if (r === 'restart') RestartApp().catch(e => toast(errMsg(e), 'error'));
  };
  return h('label', { class: 'about-lang-row' }, t('Bahasa'), sel);
}

/** Donation links and the list of donors (from donors.json on GitHub). */
function donateTab(): HTMLElement {
  const linksBox = h('div', { class: 'donate-links' });
  const donors = h('div', { class: 'donor-list muted' }, t('Memuat daftar donatur…'));
  GetDonors().then(d => {
    linksBox.replaceChildren(...d.links.map(l =>
      h('button', { class: 'btn primary donate-btn', onclick: () => BrowserOpenURL(l.url) }, '♥ ', t('Donasi lewat {0}', l.name))));
    if (!d.donors.length) { donors.replaceChildren(t('Belum ada donatur. Jadilah yang pertama!')); return; }
    donors.classList.remove('muted');
    donors.replaceChildren(...d.donors.map(x => h('div', { class: 'donor' },
      h('span', { class: 'donor-name' }, x.name),
      x.note ? h('span', { class: 'donor-note' }, x.note) : null,
      x.date ? h('span', { class: 'donor-date' }, x.date) : null)));
  }).catch(() => donors.replaceChildren(t('Daftar donatur tidak bisa dimuat.')));
  return h('div', { class: 'donate' },
    h('div', { class: 'donate-intro' },
      h('div', { class: 'donate-heart' }, '♥'),
      h('div', {},
        h('div', { class: 'donate-title' }, t('Dukung Remote Terminal')),
        h('div', { class: 'muted' }, t('Remote Terminal gratis dan open source. Jika aplikasi ini membantu pekerjaan Anda, donasi Anda membantu pengembangan fitur baru dan perbaikan.')))),
    linksBox,
    h('div', { class: 'about-section' }, t('Terima kasih kepada para donatur')),
    donors,
    h('div', { class: 'muted donate-foot' }, t('Ingin nama Anda tercantum (atau tidak)? Tulis di catatan donasi.')));
}

/** The Information window. */
export async function showAbout() {
  const version = await GetVersion();
  const lang = getLang();
  const checkBtn = h('button', { class: 'btn' }, t('Cek update'));
  const checkMsg = h('span', { class: 'about-check muted' });
  checkBtn.onclick = async () => {
    checkBtn.disabled = true;
    checkMsg.textContent = t('Memeriksa…');
    try {
      const u = await CheckUpdate();
      if (u.available) { checkMsg.textContent = ''; closeAbout(); await offerUpdate(u, true); }
      else checkMsg.textContent = t('Sudah versi terbaru ({0}).', u.current);
    } catch (e) {
      checkMsg.textContent = t('Tidak bisa memeriksa update: ') + errMsg(e);
    } finally {
      checkBtn.disabled = false;
    }
  };
  const pick = (pair: [string, string]) => (lang === 'en' ? pair[1] : pair[0]);
  const features = h('div', { class: 'about-features' }, ...FEATURES.map(g =>
    h('div', { class: 'about-group' }, h('div', { class: 'about-group-title' }, pick(g.title)),
      h('ul', {}, ...g.items.map(([id, en, since]) => h('li', {}, pick([id, en]), ' ',
        h('span', { class: 'about-since', title: t('Sejak versi {0}', since) }, `v${since}`)))))));
  const history = h('div', { class: 'about-history modal-text' });
  history.innerHTML = md((await GetChangelog()).replace(/^# .*\n/, ''));
  links(history);

  // Tabs inside the window: Features · Version history · Donate.
  const panes = { features, history, donate: donateTab() };
  const tabBtns = h('div', { class: 'seg about-tabs' });
  const show = (k: keyof typeof panes) => {
    for (const [name, el] of Object.entries(panes)) el.classList.toggle('hidden', name !== k);
    for (const b of tabBtns.children) b.classList.toggle('on', (b as HTMLElement).dataset.k === k);
  };
  for (const [k, label] of [['features', t('Fitur')], ['history', t('Riwayat versi')], ['donate', '♥ ' + t('Donasi')]] as const) {
    tabBtns.append(h('button', { type: 'button', class: 'seg-btn', 'data-k': k, onclick: () => show(k) }, label));
  }
  show('features');

  const body = h('div', { class: 'about' },
    h('div', { class: 'about-head' },
      h('div', {},
        h('div', { class: 'about-name' }, 'Remote Terminal'),
        h('div', { class: 'about-version' }, t('Versi {0}', version))),
      h('span', { class: 'ed-spacer' }),
      checkMsg, checkBtn),
    h('div', { class: 'about-bar' }, tabBtns, h('span', { class: 'ed-spacer' }), languagePicker()),
    panes.features, panes.history, panes.donate,
    h('div', { class: 'about-foot muted' }, t('Rilis dan unduhan: '),
      h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); BrowserOpenURL(RELEASES_URL); } }, 'GitHub Releases')));
  let closeAbout = () => {};
  const p = openModal(t('Informasi'), body, [{ label: t('Tutup'), value: 'close', primary: true }], undefined, 'center wide');
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
    `<h4>${t('Versi {0}', n.version)}${n.date ? ` <span class="muted">(${n.date})</span>` : ''}</h4>${md(n.notes || t('Lihat halaman rilis.'))}`).join('');
  links(notes);
  const body = h('div', {},
    h('div', { class: 'modal-text' }, t('Versi baru tersedia: '), h('b', {}, u.latest), t(' (Anda memakai {0}). Yang baru:', u.current)),
    notes);
  const r = await openModal(t('Update tersedia'), body, [
    { label: manual ? t('Nanti') : 'Skip', value: 'skip' },
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
  const label = h('div', { class: 'muted' }, t('Mengunduh…'));
  const overlay = h('div', { class: 'modal-overlay' },
    h('div', { class: 'modal center' }, h('div', { class: 'modal-title' }, t('Mengunduh Remote Terminal {0}', u.latest)),
      h('div', { class: 'xfer-bar update-bar' }, fill), label));
  document.body.append(overlay);
  const off = EventsOn('update:progress', (p: { done: number; total: number }) => {
    const total = p.total > 0 ? p.total : u.size;
    const pct = total > 0 ? Math.min(100, Math.floor(p.done / total * 100)) : 0;
    fill.style.width = pct + '%';
    label.textContent = `${(p.done / 1048576).toFixed(1)} MB${total > 0 ? t(' dari {0} MB', (total / 1048576).toFixed(1)) : ''}`;
  });
  let path = '';
  try {
    path = await DownloadUpdate(u.assetUrl);
  } catch (e) {
    toast(t('Update gagal diunduh: ') + errMsg(e), 'error');
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
    h('p', {}, t('Remote Terminal {0} sudah diunduh ke ', version), code(path), '.'),
    h('ol', {},
      h('li', {}, t('Tutup Remote Terminal ini (semua jendelanya).')),
      h('li', {}, t('Pindahkan '), code(newName), t(' dari folder Download ke folder aplikasi '), code(loc.exeDir),
        ...(newName !== 'RemoteTerminal.exe' ? [t(' dan beri nama '), code('RemoteTerminal.exe')] : []),
        t('. Jika Windows bertanya, pilih '), h('b', {}, t('Ganti file (Replace)')), '.'),
      oldName.toLowerCase() !== 'remoteterminal.exe'
        ? h('li', {}, t('File lama '), code(oldName), t(' boleh dihapus setelah file baru dipindahkan — hanya file .exe itu saja.'))
        : null,
      h('li', { class: 'warn-step' }, h('b', {}, t('Jangan hapus ')), code('config.toml'), t(' dan '), code('known_hosts'),
        configHere ? t(' di folder aplikasi') : '', t(': daftar server, password terenkripsi, dan pengaturan Anda tersimpan di sana'),
        ...(configHere ? ['.'] : [' (', code(loc.configPath), ').'])),
      h('li', {}, t('Jalankan '), code('RemoteTerminal.exe'), t(' yang baru. Versinya bisa dicek lewat tombol ⓘ (Informasi).'))),
    h('div', { class: 'install-btns' },
      h('button', { class: 'btn', onclick: () => OpenLocalFolder(dlDir) }, t('Buka folder Download')),
      h('button', { class: 'btn', onclick: () => OpenLocalFolder(loc.exeDir) }, t('Buka folder aplikasi'))));
  await openModal(t('Update siap dipasang'), body, [{ label: t('Mengerti'), value: 'ok', primary: true }], undefined, 'center wide');
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
