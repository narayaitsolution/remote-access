// SFTP file browser on the left. Follows the focused terminal's directory by default.
import {
  CancelTransfer, Chmod, CreateFile, DownloadDialog, Info, ListDir, Mkdir, OpenLocalFolder,
  Remove, Rename, Upload, UploadDialog,
} from '../wailsjs/go/main/App';
import { ClipboardSetText, EventsOn, OnFileDrop } from '../wailsjs/runtime/runtime';
import { icons } from './icons';
import type { Pane } from './pane';
import { hooks, saveSettingsSoon, store } from './state';
import {
  confirmDialog, contextMenu, errMsg, fmtDate, fmtSize, h, isModalOpen, promptText, toast, type MenuItem,
} from './ui';

interface Entry { name: string; size: number; mode: string; modTime: number; isDir: boolean; isLink: boolean }
interface Xfer { id: string; kind: string; name: string; total: number; done: number; state: string; error: string; dir: string; sessId: string }

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
    this.followBtn = tb(icons.follow, 'Ikuti folder terminal', () => this.setFollow(true));
    const toolbar = h('div', { class: 'sb-toolbar' },
      tb(icons.up, 'Naik ke folder sebelumnya (Backspace)', () => this.goUp()),
      tb(icons.upload, 'Upload…', () => this.uploadMenu()),
      tb(icons.download, 'Download', () => this.download()),
      tb(icons.filePlus, 'File baru', () => this.newFile()),
      tb(icons.folderPlus, 'Folder baru', () => this.newFolder()),
      tb(icons.rename, 'Rename (F2)', () => this.rename()),
      tb(icons.trash, 'Hapus (Del)', () => this.remove()),
      tb(icons.refresh, 'Refresh', () => this.refresh()),
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
    EventsOn('xfer', (t: Xfer) => this.onXfer(t));
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
      this.placeholder(p.state === 'picker' ? 'Pilih server untuk melihat file.' : 'Belum terhubung.');
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

  async navigate(path: string, byUser = true) {
    const p = this.pane;
    if (!p || !p.connected) return;
    if (byUser) this.setFollow(false);
    const seq = ++this.loadSeq;
    this.loading = true;
    try {
      const res = await ListDir(p.sessionId, path);
      if (seq !== this.loadSeq || p !== this.pane) return;
      const samePath = res.path === this.path;
      this.path = res.path;
      p.sb.path = res.path;
      this.entries = (res.entries || []) as Entry[];
      if (!samePath) { this.selected.clear(); this.anchor = -1; }
      else for (const n of [...this.selected]) if (!this.entries.some(e => e.name === n)) this.selected.delete(n);
      this.render();
    } catch (e) {
      if (seq === this.loadSeq) toast(errMsg(e), 'error');
    } finally {
      if (seq === this.loadSeq) this.loading = false;
    }
  }

  refresh() { if (this.pane?.connected) this.navigate(this.path, false); }
  private goUp() { if (this.path) this.navigate(parent(this.path)); }

  private render() {
    this.pathInput.value = this.path;
    const rows: HTMLElement[] = [];
    if (this.path !== '/') {
      const up = h('div', { class: 'sb-row up' }, h('span', { class: 'sb-icon', html: icons.folder }), h('span', { class: 'sb-name' }, '..'));
      up.addEventListener('dblclick', () => this.goUp());
      rows.push(up);
    }
    this.entries.forEach((e, i) => {
      const row = h('div', {
        class: 'sb-row' + (e.isDir ? ' dir' : '') + (e.name.startsWith('.') ? ' hiddenfile' : ''),
        title: `${e.name}\n${e.mode}  ${fmtDate(e.modTime)}${e.isDir ? '' : '  ' + fmtSize(e.size)}`,
      },
        h('span', { class: 'sb-icon', html: e.isDir ? icons.folder : icons.file }),
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

  private open(e: Entry) {
    if (e.isDir) this.navigate(join(this.path, e.name));
    else this.download([join(this.path, e.name)]);
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
    else if (e.key === 'F5') this.refresh();
    else if (e.ctrlKey && e.key.toLowerCase() === 'a') { this.selected = new Set(this.entries.map(x => x.name)); this.renderSel(); }
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  // ---------- actions ----------
  private need(): string | null {
    if (!this.pane?.connected) { toast('Tidak terhubung', 'error'); return null; }
    return this.pane.sessionId;
  }

  private async act(fn: () => Promise<unknown>) {
    try { await fn(); } catch (e) { toast(errMsg(e), 'error'); }
    this.refresh();
  }

  private uploadMenu() {
    const btn = this.el.querySelector('.sb-toolbar .icon-btn:nth-child(2)')!.getBoundingClientRect();
    contextMenu(btn.left, btn.bottom + 2, [
      { label: 'Upload file…', icon: icons.file, action: () => this.upload(false) },
      { label: 'Upload folder…', icon: icons.folder, action: () => this.upload(true) },
    ]);
  }

  private upload(folder: boolean, dir = this.path) {
    const id = this.need();
    if (id) UploadDialog(id, dir, folder).catch(e => toast(errMsg(e), 'error'));
  }

  private download(paths = this.selPaths()) {
    const id = this.need();
    if (!id) return;
    if (!paths.length) { toast('Pilih file/folder yang akan di-download'); return; }
    DownloadDialog(id, paths).catch(e => toast(errMsg(e), 'error'));
  }

  private async newFile() {
    const id = this.need();
    if (!id) return;
    const name = await promptText('File baru', `Nama file di ${this.path}`);
    if (name) this.act(() => CreateFile(id, join(this.path, name)));
  }

  private async newFolder() {
    const id = this.need();
    if (!id) return;
    const name = await promptText('Folder baru', `Nama folder di ${this.path}`);
    if (name) this.act(() => Mkdir(id, join(this.path, name)));
  }

  private async rename() {
    const id = this.need();
    if (!id) return;
    const sel = this.selPaths();
    if (sel.length !== 1) { toast('Pilih satu file/folder untuk di-rename'); return; }
    const old = sel[0].split('/').pop()!;
    const name = await promptText('Rename', 'Nama baru', old, true);
    if (name && name !== old) this.act(() => Rename(id, sel[0], join(this.path, name)));
  }

  private async remove() {
    const id = this.need();
    if (!id) return;
    const sel = this.selPaths();
    if (!sel.length) return;
    const what = sel.length === 1 ? `"${sel[0].split('/').pop()}"` : `${sel.length} item`;
    const hasDir = this.entries.some(e => this.selected.has(e.name) && e.isDir);
    if (await confirmDialog('Hapus', `Hapus ${what}${hasDir ? ' beserta seluruh isinya' : ''}? Tindakan ini tidak bisa dibatalkan.`, 'Hapus', true)) {
      this.act(() => Remove(id, sel));
    }
  }

  private async chmod(e: Entry) {
    const id = this.need();
    if (!id) return;
    const cur = modeToOctal(e.mode);
    const mode = await promptText('Ubah izin (chmod)', `Mode oktal untuk ${e.name} (sekarang ${cur})`, cur);
    if (mode) this.act(() => Chmod(id, join(this.path, e.name), mode));
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
    if (e.isDir && !multi) items.push({ label: 'Buka', icon: icons.folder, action: () => this.navigate(full) });
    items.push(
      { label: multi ? `Download ${this.selected.size} item` : 'Download', icon: icons.download, action: () => this.download() },
      { label: 'Rename', icon: icons.rename, hint: 'F2', disabled: multi, action: () => this.rename() },
      { label: multi ? `Hapus ${this.selected.size} item` : 'Hapus', icon: icons.trash, hint: 'Del', action: () => this.remove() },
      { sep: true },
      { label: 'Salin path', icon: icons.copy, action: () => ClipboardSetText(multi ? this.selPaths().join('\n') : full) },
      { label: 'Ubah izin (chmod)…', disabled: multi, action: () => this.chmod(e) },
      { label: 'Buka di terminal', icon: icons.follow, disabled: multi, action: () => this.cdInTerminal(e.isDir ? full : this.path) },
    );
    if (e.isDir && !multi) {
      items.push({ sep: true },
        { label: 'Upload file ke sini…', icon: icons.upload, action: () => this.upload(false, full) },
        { label: 'Upload folder ke sini…', icon: icons.upload, action: () => this.upload(true, full) });
    }
    contextMenu(x, y, items);
  }

  private blankMenu(x: number, y: number) {
    if (!this.pane?.connected) return;
    contextMenu(x, y, [
      { label: 'Upload file…', icon: icons.upload, action: () => this.upload(false) },
      { label: 'Upload folder…', icon: icons.upload, action: () => this.upload(true) },
      { sep: true },
      { label: 'File baru', icon: icons.filePlus, action: () => this.newFile() },
      { label: 'Folder baru', icon: icons.folderPlus, action: () => this.newFolder() },
      { sep: true },
      { label: 'Salin path folder ini', icon: icons.copy, action: () => ClipboardSetText(this.path) },
      { label: 'Buka di terminal', icon: icons.follow, action: () => this.cdInTerminal(this.path) },
      { label: 'Refresh', icon: icons.refresh, hint: 'F5', action: () => this.refresh() },
    ]);
  }

  // ---------- drag & drop from Explorer ----------
  private onDrop(x: number, y: number, paths: string[]) {
    const id = this.need();
    if (!id || !paths?.length) return;
    let dir = this.path;
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('.sb-row.dir');
    if (row?.dataset.name) dir = join(this.path, row.dataset.name);
    Upload(id, paths, dir).catch(e => toast(errMsg(e), 'error'));
  }

  // ---------- transfers ----------
  private onXfer(t: Xfer) {
    let item = this.xfers.get(t.id);
    if (!item) {
      const el = h('div', { class: 'xfer' });
      item = { data: t, el };
      this.xfers.set(t.id, item);
      this.xferBox.append(el);
    }
    item.data = t;
    const pct = t.total > 0 ? Math.floor((t.done / t.total) * 100) : (t.state === 'done' ? 100 : 0);
    const icon = t.kind === 'upload' ? icons.upload : icons.download;
    const status = t.state === 'running' ? `${fmtSize(t.done)} / ${fmtSize(t.total)}` :
      t.state === 'done' ? 'Selesai' : t.state === 'cancelled' ? 'Dibatalkan' : 'Gagal: ' + t.error;
    const close = h('button', { class: 'icon-btn small', html: icons.x, title: t.state === 'running' ? 'Batalkan' : 'Tutup' });
    close.onclick = () => {
      if (t.state === 'running') CancelTransfer(t.id);
      else { item!.el.remove(); this.xfers.delete(t.id); }
    };
    item.el.className = 'xfer ' + t.state;
    item.el.replaceChildren(
      h('div', { class: 'xfer-head' }, h('span', { class: 'xfer-icon', html: icon }),
        h('span', { class: 'xfer-name', title: t.name }, t.name), close),
      h('div', { class: 'xfer-bar' }, h('div', { class: 'xfer-fill', style: `width:${pct}%` })),
      h('div', { class: 'xfer-status', title: status }, status));
    if (t.kind === 'download' && t.state === 'done') {
      item.el.title = 'Klik untuk membuka folder';
      item.el.style.cursor = 'pointer';
      item.el.onclick = ev => { if (ev.target !== close) OpenLocalFolder(t.dir); };
    }
    if (t.state === 'done' || t.state === 'cancelled') {
      setTimeout(() => { item!.el.remove(); this.xfers.delete(t.id); }, 5000);
      if (t.kind === 'upload' && this.pane?.sessionId === t.sessId) this.refresh();
    }
  }
}

function modeToOctal(mode: string): string {
  const p = mode.slice(-9);
  let n = 0;
  for (let i = 0; i < 9; i++) if (p[i] && p[i] !== '-') n |= 1 << (8 - i);
  return n.toString(8).padStart(3, '0');
}
