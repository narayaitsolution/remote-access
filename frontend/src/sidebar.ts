// SFTP file browser on the left. Follows the focused terminal's directory by default.
import {
  AppForFile, CancelTransfer, Chmod, CreateFile, DownloadDialog, EditLocally, Info, ListDir, Mkdir, OpenLocalFolder,
  Remove, Rename, StopLocalEdit, Upload, UploadDialog,
} from '../wailsjs/go/main/App';
import { extOf, OFFICE_EXT } from './viewers';
import { fileIcon, loadIcons } from './fileicons';
import { ClipboardSetText, EventsOn, OnFileDrop } from '../wailsjs/runtime/runtime';
import { icons } from './icons';
import type { Pane } from './pane';
import { hooks, saveSettingsSoon, store } from './state';
import { t } from './i18n';
import {
  confirmDialog, contextMenu, errMsg, fmtDate, fmtSize, h, isModalOpen, promptText, toast, type MenuItem,
} from './ui';

interface Entry { name: string; size: number; mode: string; modTime: number; isDir: boolean; isLink: boolean }
interface Xfer {
  id: string; kind: string; name: string; total: number; done: number; state: string; error: string; dir: string; sessId: string;
  /** File n of count in a batch (files picked or dropped together). */
  index: number; count: number; batch: string;
}

const join = (dir: string, name: string) => (dir === '/' ? '' : dir.replace(/\/+$/, '')) + '/' + name;
const parent = (p: string) => p.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';
const shq = (s: string) => "'" + s.replace(/'/g, `'\\''`) + "'";

export class Sidebar {
  el: HTMLElement;
  private resizer: HTMLElement;
  private pathInput: HTMLInputElement;
  private list: HTMLElement;
  private xferBox: HTMLElement;
  private followBtn!: HTMLButtonElement;
  private pane: Pane | null = null;
  private path = '';
  private entries: Entry[] = [];
  private selected = new Set<string>();
  private anchor = -1;
  private loading = false;
  private loadSeq = 0;
  private xfers = new Map<string, { data: Xfer; el: HTMLElement }>();

  constructor() {
    const tb = (icon: string, title: string, fn: () => void) =>
      h('button', { class: 'icon-btn', title, html: icon, onclick: fn });
    this.followBtn = tb(icons.follow, t('Ikuti folder terminal'), () => this.setFollow(true));
    const toolbar = h('div', { class: 'sb-toolbar' },
      tb(icons.up, t('Naik ke folder sebelumnya (Backspace)'), () => this.goUp()),
      tb(icons.upload, 'Upload…', () => this.uploadMenu()),
      tb(icons.download, 'Download', () => this.download()),
      tb(icons.filePlus, t('File baru'), () => this.newFile()),
      tb(icons.folderPlus, t('Folder baru'), () => this.newFolder()),
      tb(icons.rename, 'Rename (F2)', () => this.rename()),
      tb(icons.trash, t('Hapus (Del)'), () => this.remove()),
      tb(icons.refresh, 'Refresh (F5)', () => this.refresh(true)),
      this.followBtn);
    this.pathInput = h('input', { class: 'sb-path', type: 'text', spellcheck: 'false' });
    this.pathInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this.navigate(this.pathInput.value.trim()); this.list.focus(); }
      if (e.key === 'Escape') { this.pathInput.value = this.path; this.list.focus(); }
    });
    this.list = h('div', { class: 'sb-list', tabindex: '0' });
    this.list.style.setProperty('--wails-drop-target', 'drop');
    this.list.addEventListener('keydown', e => this.onKey(e));
    this.list.addEventListener('contextmenu', e => {
      if (e.target === this.list) { e.preventDefault(); this.selected.clear(); this.renderSel(); this.blankMenu(e.clientX, e.clientY); }
    });
    this.list.addEventListener('mousedown', e => { if (e.target === this.list) { this.selected.clear(); this.renderSel(); } });
    this.xferBox = h('div', { class: 'sb-xfers' });
    this.resizer = h('div', { class: 'sb-resizer' });
    this.el = h('div', { class: 'sidebar' }, toolbar, this.pathInput, this.list, this.xferBox, this.resizer);
    this.setupResize();
    this.applyVisibility();

    OnFileDrop((x, y, paths) => this.onDrop(x, y, paths), true);
    EventsOn('xfer', (x: Xfer) => this.onXfer(x));
    EventsOn('localEdit', (le: any) => this.onLocalEdit(le));
    setInterval(() => this.followTick(), 1500);
  }

  applyVisibility() {
    this.el.classList.toggle('hidden', !store.settings.sidebarVisible);
    this.el.style.width = store.settings.sidebarWidth + 'px';
  }

  private setupResize() {
    this.resizer.addEventListener('mousedown', e => {
      e.preventDefault();
      const startX = e.clientX, startW = this.el.offsetWidth;
      const move = (ev: MouseEvent) => {
        store.settings.sidebarWidth = Math.max(180, Math.min(800, startW + ev.clientX - startX));
        this.el.style.width = store.settings.sidebarWidth + 'px';
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        document.body.classList.remove('resizing');
        saveSettingsSoon();
        hooks.allPanes().forEach(p => p.refit());
      };
      document.body.classList.add('resizing');
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  /** Called whenever the focused pane or its connection state changes. */
  bind(p: Pane) {
    const changed = this.pane !== p;
    this.pane = p;
    this.followBtn.classList.toggle('on', p.sb.follow);
    if (p.connected) {
      if (changed || this.boundSession !== p.sessionId) {
        this.boundSession = p.sessionId;
        this.path = '';
        this.navigate(p.sb.path || '', false);
        if (p.sb.follow) setTimeout(() => this.followTick(true), 300);
      }
    } else if (changed || p.state === 'picker' || p.state === 'connecting') {
      this.boundSession = '';
      this.placeholder(p.state === 'picker' ? t('Pilih server untuk melihat file.') : t('Belum terhubung.'));
    }
  }
  private boundSession = '';

  private placeholder(msg: string) {
    this.path = '';
    this.entries = [];
    this.selected.clear();
    this.pathInput.value = '';
    this.list.replaceChildren(h('div', { class: 'sb-empty' }, msg));
  }

  private setFollow(on: boolean) {
    if (!this.pane) return;
    this.pane.sb.follow = on;
    this.followBtn.classList.toggle('on', on);
    if (on) this.followTick(true);
  }

  private async followTick(force = false) {
    const p = this.pane;
    if (!p || !p.connected || !p.sb.follow || !store.settings.sidebarVisible) return;
    if (!force && (document.hidden || this.loading)) return;
    try {
      const info = await Info(p.sessionId);
      if (p !== this.pane || !p.sb.follow) return;
      if (info.cwd && info.cwd !== this.path) this.navigate(info.cwd, false);
    } catch { /* not ready yet */ }
  }

  /** Called when the user types Enter in a terminal: refresh sooner. */
  poke() { setTimeout(() => this.followTick(), 400); }

  /** Loads a directory. Resolves true on success. */
  async navigate(path: string, byUser = true): Promise<boolean> {
    const p = this.pane;
    if (!p || !p.connected) return false;
    if (byUser) this.setFollow(false);
    const seq = ++this.loadSeq;
    this.loading = true;
    try {
      const res = await ListDir(p.sessionId, path);
      if (seq !== this.loadSeq || p !== this.pane) return false;
      const samePath = res.path === this.path;
      this.path = res.path;
      p.sb.path = res.path;
      this.entries = (res.entries || []) as Entry[];
      if (!samePath) { this.selected.clear(); this.anchor = -1; }
      else for (const n of [...this.selected]) if (!this.entries.some(e => e.name === n)) this.selected.delete(n);
      await loadIcons(this.entries.concat([{ name: '..', isDir: true } as Entry]));
      if (seq !== this.loadSeq) return false;
      this.render();
      return true;
    } catch (e) {
      if (seq === this.loadSeq) toast(t('Gagal membuka folder: ') + errMsg(e), 'error');
      return false;
    } finally {
      if (seq === this.loadSeq) this.loading = false;
    }
  }

  /** Reloads the listing; `notify` shows a toast (user-triggered refresh). */
  async refresh(notify = false) {
    if (!this.pane?.connected) return;
    if (await this.navigate(this.path, false) && notify) toast(t('Daftar file diperbarui'), 'success');
  }
  private async goUp() {
    if (!this.path || this.path === '/') return;
    const target = parent(this.path);
    if (await this.navigate(target)) toast(t('Folder: ') + this.path, 'success');
  }

  private render() {
    this.pathInput.value = this.path;
    const rows: HTMLElement[] = [];
    if (this.path !== '/') {
      const up = h('div', { class: 'sb-row up' }, h('span', { class: 'sb-icon' }, fileIcon('..', true)), h('span', { class: 'sb-name' }, '..'));
      up.addEventListener('dblclick', () => this.goUp());
      rows.push(up);
    }
    this.entries.forEach((e, i) => {
      const row = h('div', {
        class: 'sb-row' + (e.isDir ? ' dir' : '') + (e.name.startsWith('.') ? ' hiddenfile' : ''),
        title: `${e.name}\n${e.mode}  ${fmtDate(e.modTime)}${e.isDir ? '' : '  ' + fmtSize(e.size)}`,
      },
        h('span', { class: 'sb-icon' }, fileIcon(e.name, e.isDir)),
        h('span', { class: 'sb-name' }, e.name + (e.isLink ? ' →' : '')),
        h('span', { class: 'sb-size' }, e.isDir ? '' : fmtSize(e.size)));
      row.dataset.name = e.name;
      row.addEventListener('mousedown', ev => this.clickRow(ev, i));
      row.addEventListener('dblclick', () => this.open(e));
      row.addEventListener('contextmenu', ev => {
        ev.preventDefault();
        if (!this.selected.has(e.name)) { this.selected = new Set([e.name]); this.anchor = i; this.renderSel(); }
        this.rowMenu(ev.clientX, ev.clientY, e);
      });
      rows.push(row);
    });
    this.list.replaceChildren(...rows);
    this.renderSel();
  }

  private renderSel() {
    for (const row of this.list.querySelectorAll<HTMLElement>('.sb-row')) {
      row.classList.toggle('sel', !!row.dataset.name && this.selected.has(row.dataset.name));
    }
  }

  private clickRow(ev: MouseEvent, i: number) {
    const name = this.entries[i].name;
    if (ev.button !== 0) return;
    if (ev.ctrlKey) {
      this.selected.has(name) ? this.selected.delete(name) : this.selected.add(name);
      this.anchor = i;
    } else if (ev.shiftKey && this.anchor >= 0) {
      const [a, b] = [Math.min(this.anchor, i), Math.max(this.anchor, i)];
      this.selected = new Set(this.entries.slice(a, b + 1).map(e => e.name));
    } else {
      this.selected = new Set([name]);
      this.anchor = i;
    }
    this.renderSel();
  }

  /** Double-click / Enter: folders are entered, files open in the editor. */
  private open(e: Entry) {
    if (e.isDir) { this.navigate(join(this.path, e.name)); return; }
    if (!this.pane?.connected) return;
    // Word/Excel/PowerPoint: edit in the Windows application, synced back on save.
    if (OFFICE_EXT.has(extOf(e.name))) { this.openWithApp(e); return; }
    hooks.openEditor(this.pane, join(this.path, e.name));
  }

  /** Opens a file in its Windows program; every save there is uploaded back. */
  private async openWithApp(e: Entry) {
    const id = this.need();
    if (!id) return;
    try {
      const le = await EditLocally(id, join(this.path, e.name));
      toast(t('{0} dibuka di {1}. Setiap kali disimpan, file otomatis di-upload ke server.', e.name, le.app), 'success');
    } catch (err) {
      const msg = String(err);
      if (msg.startsWith('noapp:') && OFFICE_EXT.has(extOf(e.name))) {
        const ok = await confirmDialog(t('Aplikasi Office belum ada'), t('{0}. Pasang LibreOffice (gratis) sekarang?', msg.slice(6)), t('Pasang…'));
        if (ok) hooks.showSetup('office');
      } else {
        toast(t('Tidak bisa membuka {0}: {1}', e.name, errMsg(err)), 'error');
      }
    }
  }

  private localEdits = new Map<string, HTMLElement>();
  private onLocalEdit(le: { id: string; name: string; app: string; state: string; error: string; lastSync: number; remote: string }) {
    let el = this.localEdits.get(le.id);
    if (le.state === 'closed') { el?.remove(); this.localEdits.delete(le.id); return; }
    if (!el) { el = h('div', { class: 'xfer local' }); this.localEdits.set(le.id, el); this.xferBox.prepend(el); }
    const when = le.lastSync ? new Date(le.lastSync * 1000).toLocaleTimeString() : '';
    const status = le.state === 'editing' ? t('Sedang diedit di {0} — simpan di sana untuk upload otomatis', le.app)
      : le.state === 'syncing' ? t('Mengupload perubahan…')
      : le.state === 'synced' ? t('Tersimpan ke server {0}', when)
      : t('Gagal upload: ') + le.error;
    if (le.state === 'synced') { toast(t('{0} tersimpan ke server', le.name), 'success'); if (parentDir(le.remote) === this.path) this.refresh(); }
    if (le.state === 'error') toast(t('Gagal upload {0}: {1}', le.name, le.error), 'error');
    el.className = 'xfer local ' + (le.state === 'error' ? 'error' : le.state === 'synced' ? 'done' : '');
    el.replaceChildren(
      h('div', { class: 'xfer-head' }, h('span', { class: 'xfer-icon', html: icons.rename }),
        h('span', { class: 'xfer-name', title: le.remote }, le.name),
        h('button', { class: 'btn small', title: t('Berhenti memantau file ini'), onclick: () => StopLocalEdit(le.id) }, t('Selesai'))),
      h('div', { class: 'xfer-status', title: status }, status));
  }

  private selPaths(): string[] {
    return this.entries.filter(e => this.selected.has(e.name)).map(e => join(this.path, e.name));
  }

  private onKey(e: KeyboardEvent) {
    if (isModalOpen() || !this.entries.length && e.key !== 'Backspace') return;
    const idx = this.anchor;
    const move = (d: number) => {
      const i = Math.max(0, Math.min(this.entries.length - 1, idx + d));
      this.anchor = i;
      this.selected = new Set([this.entries[i].name]);
      this.renderSel();
      this.list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    };
    let handled = true;
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'Enter' && idx >= 0) this.open(this.entries[idx]);
    else if (e.key === 'Backspace') this.goUp();
    else if (e.key === 'F2') this.rename();
    else if (e.key === 'Delete') this.remove();
    else if (e.key === 'F5') this.refresh(true);
    else if (e.ctrlKey && e.key.toLowerCase() === 'a') { this.selected = new Set(this.entries.map(x => x.name)); this.renderSel(); }
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  // ---------- actions ----------
  private need(): string | null {
    if (!this.pane?.connected) { toast(t('Tidak terhubung'), 'error'); return null; }
    return this.pane.sessionId;
  }

  /** Runs a file operation, shows a success/failure toast, then refreshes. */
  private async act(fn: () => Promise<unknown>, ok: string, fail: string) {
    try {
      await fn();
      toast(ok, 'success');
    } catch (e) {
      toast(`${fail}: ${errMsg(e)}`, 'error');
    }
    this.refresh();
  }

  private uploadMenu() {
    const btn = this.el.querySelector('.sb-toolbar .icon-btn:nth-child(2)')!.getBoundingClientRect();
    contextMenu(btn.left, btn.bottom + 2, [
      { label: t('Upload file…'), icon: icons.file, action: () => this.upload(false) },
      { label: t('Upload folder…'), icon: icons.folder, action: () => this.upload(true) },
    ]);
  }

  private upload(folder: boolean, dir = this.path) {
    const id = this.need();
    if (id) UploadDialog(id, dir, folder).catch(e => toast(t('Upload gagal: ') + errMsg(e), 'error'));
  }

  private download(paths = this.selPaths()) {
    const id = this.need();
    if (!id) return;
    if (!paths.length) { toast(t('Pilih file/folder yang akan di-download')); return; }
    DownloadDialog(id, paths).catch(e => toast(t('Download gagal: ') + errMsg(e), 'error'));
  }

  private async newFile() {
    const id = this.need();
    if (!id) return;
    const name = await promptText(t('File baru'), t('Nama file di {0}', this.path));
    if (name) this.act(() => CreateFile(id, join(this.path, name)), t('File "{0}" dibuat', name), t('Gagal membuat file'));
  }

  private async newFolder() {
    const id = this.need();
    if (!id) return;
    const name = await promptText(t('Folder baru'), t('Nama folder di {0}', this.path));
    if (name) this.act(() => Mkdir(id, join(this.path, name)), t('Folder "{0}" dibuat', name), t('Gagal membuat folder'));
  }

  private async rename() {
    const id = this.need();
    if (!id) return;
    const sel = this.selPaths();
    if (sel.length !== 1) { toast(t('Pilih satu file/folder untuk di-rename')); return; }
    const old = sel[0].split('/').pop()!;
    const name = await promptText('Rename', t('Nama baru'), old, true);
    if (name && name !== old) this.act(() => Rename(id, sel[0], join(this.path, name)), t('Rename berhasil: {0} → {1}', old, name), t('Gagal rename'));
  }

  private async remove() {
    const id = this.need();
    if (!id) return;
    const sel = this.selPaths();
    if (!sel.length) return;
    const what = sel.length === 1 ? `"${sel[0].split('/').pop()}"` : t('{0} item', sel.length);
    const hasDir = this.entries.some(e => this.selected.has(e.name) && e.isDir);
    if (await confirmDialog(t('Hapus'), (hasDir ? t('Hapus {0} beserta seluruh isinya? Tindakan ini tidak bisa dibatalkan.', what) : t('Hapus {0}? Tindakan ini tidak bisa dibatalkan.', what)), t('Hapus'), true)) {
      this.act(() => Remove(id, sel), t('{0} dihapus', what), t('Gagal menghapus'));
    }
  }

  private async chmod(e: Entry) {
    const id = this.need();
    if (!id) return;
    const cur = modeToOctal(e.mode);
    const mode = await promptText(t('Ubah izin (chmod)'), t('Mode oktal untuk {0} (sekarang {1})', e.name, cur), cur);
    if (mode) this.act(() => Chmod(id, join(this.path, e.name), mode), t('Izin {0} diubah ke {1}', e.name, mode), t('Gagal mengubah izin'));
  }

  private copyText(text: string) {
    ClipboardSetText(text).then(() => toast(t('Path disalin ke clipboard'), 'success'))
      .catch(() => toast(t('Gagal menyalin ke clipboard'), 'error'));
  }

  private cdInTerminal(dir: string) {
    if (!this.pane?.connected) return;
    this.pane.send(`cd ${shq(dir)}\r`);
    this.setFollow(true);
    this.pane.focus();
  }

  private rowMenu(x: number, y: number, e: Entry) {
    const multi = this.selected.size > 1;
    const full = join(this.path, e.name);
    const items: MenuItem[] = [];
    if (e.isDir && !multi) items.push({ label: t('Buka'), icon: icons.folder, action: () => this.navigate(full) });
    if (!e.isDir && !multi) {
      const office = OFFICE_EXT.has(extOf(e.name));
      items.push({ label: office ? t('Buka (edit di aplikasi Windows)') : t('Buka'), icon: icons.rename, hint: 'Double-click', action: () => this.open(e) });
      if (office) items.push({ label: t('Buka sebagai teks di editor'), icon: icons.file, action: () => this.pane && hooks.openEditor(this.pane, full) });
      else items.push({ label: t('Buka dengan aplikasi Windows'), icon: icons.file, action: async () => {
        const app = await AppForFile(e.name);
        if (!app) { toast(t('Tidak ada aplikasi Windows untuk file .{0}', extOf(e.name) || t('(tanpa ekstensi)')), 'error'); return; }
        this.openWithApp(e);
      } });
    }
    items.push(
      { label: multi ? t('Download {0} item', this.selected.size) : 'Download', icon: icons.download, action: () => this.download() },
      { label: 'Rename', icon: icons.rename, hint: 'F2', disabled: multi, action: () => this.rename() },
      { label: multi ? t('Hapus {0} item', this.selected.size) : t('Hapus'), icon: icons.trash, hint: 'Del', action: () => this.remove() },
      { sep: true },
      { label: t('Salin path'), icon: icons.copy, action: () => this.copyText(multi ? this.selPaths().join('\r\n') : full) },
      { label: t('Ubah izin (chmod)…'), disabled: multi, action: () => this.chmod(e) },
      { label: t('Buka di terminal'), icon: icons.follow, disabled: multi, action: () => this.cdInTerminal(e.isDir ? full : this.path) },
    );
    if (e.isDir && !multi) {
      items.push({ sep: true },
        { label: t('Upload file ke sini…'), icon: icons.upload, action: () => this.upload(false, full) },
        { label: t('Upload folder ke sini…'), icon: icons.upload, action: () => this.upload(true, full) });
    }
    contextMenu(x, y, items);
  }

  private blankMenu(x: number, y: number) {
    if (!this.pane?.connected) return;
    contextMenu(x, y, [
      { label: t('Upload file…'), icon: icons.upload, action: () => this.upload(false) },
      { label: t('Upload folder…'), icon: icons.upload, action: () => this.upload(true) },
      { sep: true },
      { label: t('File baru'), icon: icons.filePlus, action: () => this.newFile() },
      { label: t('Folder baru'), icon: icons.folderPlus, action: () => this.newFolder() },
      { sep: true },
      { label: t('Salin path folder ini'), icon: icons.copy, action: () => this.copyText(this.path) },
      { label: t('Buka di terminal'), icon: icons.follow, action: () => this.cdInTerminal(this.path) },
      { label: 'Refresh', icon: icons.refresh, hint: 'F5', action: () => this.refresh(true) },
    ]);
  }

  // ---------- drag & drop from Explorer ----------
  private onDrop(x: number, y: number, paths: string[]) {
    const id = this.need();
    if (!id || !paths?.length) return;
    let dir = this.path;
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('.sb-row.dir');
    if (row?.dataset.name) dir = join(this.path, row.dataset.name);
    Upload(id, paths, dir).catch(e => toast(t('Upload gagal: ') + errMsg(e), 'error'));
  }

  // ---------- transfers ----------
  private onXfer(x: Xfer) {
    let item = this.xfers.get(x.id);
    if (!item) {
      const el = h('div', { class: 'xfer' });
      item = { data: x, el };
      this.xfers.set(x.id, item);
      this.xferBox.append(el);
    }
    item.data = x;
    const pct = x.total > 0 ? Math.floor((x.done / x.total) * 100) : (x.state === 'done' ? 100 : 0);
    const icon = x.kind === 'upload' ? icons.upload : icons.download;
    const status = x.state === 'running' ? `${fmtSize(x.done)} / ${fmtSize(x.total)}` :
      x.state === 'done' ? t('Selesai') : x.state === 'cancelled' ? t('Dibatalkan') : t('Gagal: ') + x.error;
    const multi = x.count > 1;
    const close = h('button', { class: 'icon-btn small', html: icons.x,
      title: x.state === 'running' ? (multi ? t('Batalkan (file berikutnya juga dibatalkan)') : t('Batalkan')) : t('Tutup') });
    close.onclick = () => {
      if (x.state === 'running') CancelTransfer(x.id);
      else { item!.el.remove(); this.xfers.delete(x.id); }
    };
    item.el.className = 'xfer ' + x.state;
    item.el.replaceChildren(
      h('div', { class: 'xfer-head' }, h('span', { class: 'xfer-icon', html: icon }),
        h('span', { class: 'xfer-name', title: x.name }, x.name),
        multi ? h('span', { class: 'xfer-count', title: t('File ke-{0} dari {1}', x.index, x.count) }, `${x.index}/${x.count}`) : null, close),
      h('div', { class: 'xfer-bar' }, h('div', { class: 'xfer-fill', style: `width:${pct}%` })),
      h('div', { class: 'xfer-status', title: status }, status));
    if (x.kind === 'download' && x.state === 'done') {
      item.el.title = t('Klik untuk membuka folder');
      item.el.style.cursor = 'pointer';
      item.el.onclick = ev => { if (ev.target !== close) OpenLocalFolder(x.dir); };
    }
    const label = x.kind === 'upload' ? 'Upload' : 'Download';
    // One toast per batch, not per file.
    if (x.state === 'done' && x.index === x.count) toast(multi ? t('{0} berhasil: {1} file', label, x.count) : t('{0} berhasil: {1}', label, x.name), 'success');
    else if (x.state === 'error') toast(t('{0} gagal: {1} — {2}', label, x.name, x.error), 'error');
    else if (x.state === 'cancelled') toast(multi ? t('{0} dibatalkan di file {1} dari {2} ({3})', label, x.index, x.count, x.name) : t('{0} dibatalkan: {1}', label, x.name));
    if (x.state === 'done' || x.state === 'cancelled') {
      setTimeout(() => { item!.el.remove(); this.xfers.delete(x.id); }, multi ? 2500 : 5000);
      if (x.kind === 'upload' && this.pane?.sessionId === x.sessId && (x.index === x.count || x.state === 'cancelled')) this.refresh();
    }
  }
}

function modeToOctal(mode: string): string {
  const p = mode.slice(-9);
  let n = 0;
  for (let i = 0; i < 9; i++) if (p[i] && p[i] !== '-') n |= 1 << (8 - i);
  return n.toString(8).padStart(3, '0');
}

function parentDir(p: string) { return p.replace(/\/[^/]*$/, '') || '/'; }
