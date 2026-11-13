// A pane is one cell of the split layout: either the server picker or a terminal.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Close, Connect, Reconnect, Resize, Write, WriteBinary } from '../wailsjs/go/main/App';
import { ClipboardGetText, ClipboardSetText, EventsOn } from '../wailsjs/runtime/runtime';
import { askPassword, Picker } from './picker';
import { hooks, refreshState, store, type ProfileView } from './state';
import { viewFor, type FileView } from './viewers';
import { errMsg, h, openModal, toast } from './ui';

export type PaneState = 'picker' | 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'failed' | 'editor';

const termTheme = {
  background: '#18181b', foreground: '#e4e4e7', cursor: '#e4e4e7', cursorAccent: '#18181b',
  selectionBackground: '#3f6fb580',
  black: '#27272a', red: '#f87171', green: '#4ade80', yellow: '#facc15', blue: '#60a5fa',
  magenta: '#c084fc', cyan: '#22d3ee', white: '#d4d4d8',
  brightBlack: '#71717a', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde047',
  brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#fafafa',
};

const termByEl = new WeakMap<Element, Pane>();
let uid = 0;

export class Pane {
  id = ++uid;
  el: HTMLDivElement;
  state: PaneState = 'picker';
  title = 'Pilih server';
  profile: ProfileView | null = null;
  sessionId = '';
  term: Terminal | null = null;
  /** Per-pane sidebar position. */
  sb = { path: '', follow: true };

  private picker: Picker | null = null;
  private fit: FitAddon | null = null;
  private badge: HTMLDivElement;
  private unsubs: (() => void)[] = [];
  private ro: ResizeObserver;

  /** Set when this pane shows a file editor instead of a terminal. */
  editor: FileView | null = null;
  /** The terminal pane whose connection the editor uses (for sidebar and AI). */
  editorSrc: Pane | null = null;

  constructor(showPicker = true) {
    this.badge = h('div', { class: 'pane-badge hidden' });
    this.el = h('div', { class: 'pane' });
    this.el.addEventListener('mousedown', () => hooks.focusPane(this), true);
    this.ro = new ResizeObserver(() => this.refit());
    this.ro.observe(this.el);
    if (showPicker) this.showPicker();
  }

  get connected() { return this.state === 'connected' && !!this.sessionId; }

  focus() {
    if (this.editor) this.editor.focus();
    else if (this.term) this.term.focus();
    else this.picker?.focus();
  }

  /** Turns this pane into an editor for a remote file. Resolves false if it could not be opened. */
  async openEditor(src: Pane, path: string): Promise<boolean> {
    this.editorSrc = src;
    const ed: FileView = viewFor(src.sessionId, path, () => {
      this.title = (ed.dirty ? '● ' : '') + ed.fileName;
      hooks.paneChanged(this);
    });
    this.editor = ed;
    this.title = ed.fileName;
    this.el.replaceChildren(ed.el);
    this.state = 'editor';
    hooks.paneChanged(this);
    try {
      await ed.load();
      return true;
    } catch (e) {
      toast(`Tidak bisa membuka ${ed.fileName}: ${errMsg(e)}`, 'error');
      return false;
    }
  }

  /** Asks about unsaved changes. Resolves true when the pane may be closed. */
  async canClose(): Promise<boolean> {
    if (!this.editor?.dirty) return true;
    const body = h('div', { class: 'modal-text' });
    body.textContent = `Simpan perubahan pada "${this.editor.fileName}" sebelum ditutup?`;
    const r = await openModal('Perubahan belum disimpan', body, [
      { label: 'Batal', value: 'cancel' },
      { label: 'Jangan simpan', value: 'discard', danger: true },
      { label: 'Simpan', value: 'save', primary: true },
    ]);
    if (r === 'save') return this.editor.save();
    return r === 'discard';
  }

  private setState(s: PaneState) {
    this.state = s;
    hooks.paneChanged(this);
  }

  showPicker() {
    this.teardownTerm();
    this.profile = null;
    this.title = 'Pilih server';
    this.el.innerHTML = '';
    this.picker = new Picker(p => this.start(p));
    this.el.append(this.picker.el);
    this.setState('picker');
    setTimeout(() => { if (hooks.activePane() === this) this.focus(); }, 0);
  }

  private mountTerm() {
    this.picker?.dispose();
    this.picker = null;
    this.el.innerHTML = '';
    const host = h('div', { class: 'term-host' });
    this.el.append(host, this.badge);
    const s = store.settings;
    const term = new Terminal({
      fontFamily: s.fontFamily, fontSize: s.fontSize, scrollback: s.scrollback,
      cursorBlink: true, allowProposedApi: true, theme: termTheme,
      rightClickSelectsWord: false, macOptionClickForcesSelection: false,
      drawBoldTextInBrightColors: false, minimumContrastRatio: 1,
    });
    this.fit = new FitAddon();
    term.loadAddon(this.fit);
    term.open(host);
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      term.loadAddon(gl);
    } catch { /* canvas/DOM renderer fallback */ }
    termByEl.set(host, this);
    this.term = term;

    term.onData(d => this.input(d));
    term.onBinary(d => {
      if (!this.connected) return;
      const b = new Uint8Array(d.length);
      for (let i = 0; i < d.length; i++) b[i] = d.charCodeAt(i) & 0xff;
      WriteBinary(this.sessionId, btoa(String.fromCharCode(...b)));
    });
    term.onResize(({ cols, rows }) => { if (this.sessionId) Resize(this.sessionId, cols, rows); });
    term.attachCustomKeyEventHandler(e => {
      if (e.type === 'keydown' && e.shiftKey && e.key === 'Insert') { e.preventDefault(); this.paste(); return false; }
      return true;
    });
    host.addEventListener('contextmenu', e => { e.preventDefault(); this.paste(); });
    host.addEventListener('auxclick', e => { if (e.button === 1) { e.preventDefault(); this.paste(); } });
    this.refit();
  }

  private teardownTerm() {
    this.unsubs.forEach(f => f());
    this.unsubs = [];
    if (this.sessionId) Close(this.sessionId);
    this.sessionId = '';
    this.term?.dispose();
    this.term = null;
    this.fit = null;
    this.badge.classList.add('hidden');
  }

  refit() {
    if (!this.term || !this.fit) return;
    if (this.el.clientWidth < 20 || this.el.clientHeight < 20) return;
    requestAnimationFrame(() => {
      try { this.fit?.fit(); } catch { /* not visible */ }
    });
  }

  setFont(family: string, size: number) {
    this.editor?.setFontSize(size);
    if (!this.term) return;
    this.term.options.fontFamily = family;
    this.term.options.fontSize = size;
    this.refit();
  }

  /** Copies the selection to the Windows clipboard (never the server's). */
  copySelection() {
    if (!this.term) return;
    const text = selectionText(this.term);
    if (!text) return;
    ClipboardSetText(text).then(ok => {
      if (ok === false) { toast('Gagal menyalin ke clipboard', 'error'); return; }
      const lines = text.split('\r\n').length;
      toast(lines > 1 ? `Copy berhasil (${lines} baris)` : 'Copy berhasil', 'success');
    }).catch(() => toast('Gagal menyalin ke clipboard', 'error'));
  }

  async paste() {
    const text = await ClipboardGetText();
    if (text && this.term) this.term.paste(text.replace(/\r?\n/g, '\r'));
  }

  private failedRetry: (() => void) | null = null;

  private input(d: string) {
    if (this.state === 'connected') {
      Write(this.sessionId, d);
      if (d.includes('\r')) hooks.enterPressed(this);
      return;
    }
    if (this.state === 'ended') {
      if (d === '\r') this.reconnect();
      return;
    }
    if (this.state === 'failed') {
      if (d === '\r') this.failedRetry?.();
      else if (d === '\x1b') this.showPicker();
    }
  }

  private status(msg: string, color = '90') {
    this.term?.write(`\r\n\x1b[${color}m${msg}\x1b[0m\r\n`);
  }

  /** Start a new connection from the picker. */
  async start(p: ProfileView, password = "", save = false): Promise<void> {
    // Key logins try without asking; a passphrase is requested only if the key needs one.
    if (p.authType !== 'key' && !p.hasPassword && !password) {
      const r = await askPassword(p);
      if (!r) return;
      password = r.password; save = r.save;
    }
    this.profile = p;
    this.title = p.name;
    if (!this.term) this.mountTerm();
    this.setState('connecting');
    this.term!.write(`\x1b[90mMenghubungkan ke ${p.user}@${p.host}:${p.port} …\x1b[0m`);
    await new Promise(r => setTimeout(r, 30)); // let fit settle
    const { cols, rows } = this.term!;
    try {
      const id = await Connect(p.id, password, save, cols, rows);
      this.sessionId = id;
      this.term!.reset();
      this.unsubs.push(
        EventsOn('d:' + id, (b64: string) => this.term?.write(b64ToBytes(b64))),
        EventsOn('s:' + id, (st: { state: string; msg: string }) => this.onSessionState(st)),
      );
      this.setState('connected');
      if (save) refreshState();
      this.term!.focus();
    } catch (e) {
      const msg = String(e);
      if (msg.startsWith('auth:')) {
        const r = await askPassword(p, errMsg(e));
        if (!r) { this.showPicker(); return; }
        this.term!.write('\r\n');
        return this.start(p, r.password, r.save);
      }
      this.setState('failed');
      this.status('Gagal konek: ' + errMsg(e), '31');
      this.status('Enter = coba lagi · Esc = kembali ke daftar server');
      this.failedRetry = () => { this.term!.write('\r\n'); this.start(p, password, false); };
    }
  }

  private onSessionState(st: { state: string; msg: string }) {
    switch (st.state) {
      case 'connected':
        this.badge.classList.add('hidden');
        this.setState('connected');
        break;
      case 'reconnecting':
        this.badge.textContent = st.msg || 'Menyambung ulang…';
        this.badge.classList.remove('hidden');
        this.setState('reconnecting');
        break;
      case 'exited':
        this.badge.classList.add('hidden');
        this.setState('ended');
        this.status('[Sesi berakhir — Enter: sambung ulang · Ctrl+Shift+W: tutup]');
        break;
      case 'error':
        this.badge.classList.add('hidden');
        this.setState('ended');
        this.status(st.msg, '31');
        this.status('[Enter: sambung ulang · Ctrl+Shift+W: tutup]');
        break;
    }
  }

  private async reconnect(password = ""): Promise<void> {
    if (!this.sessionId || !this.profile) return;
    this.setState('connecting');
    this.status('Menyambung ulang…');
    try {
      await Reconnect(this.sessionId, password);
    } catch (e) {
      if (String(e).startsWith('auth:')) {
        const r = await askPassword(this.profile, errMsg(e));
        if (r) return this.reconnect(r.password);
      } else {
        this.status('Gagal: ' + errMsg(e), '31');
      }
      this.setState('ended');
      this.status('[Enter: coba lagi · Ctrl+Shift+W: tutup]');
    }
  }

  /** Type text into the shell (e.g. "cd" from the sidebar). */
  send(text: string) {
    if (this.connected) Write(this.sessionId, text);
  }

  dispose() {
    hooks.paneDisposed(this);
    this.ro.disconnect();
    this.teardownTerm();
    this.picker?.dispose();
    this.editor?.dispose();
    this.el.remove();
  }
}

/** One screen row of a selection. */
export interface SelRow {
  /** Selected part of the row, including trailing blanks. */
  full: string;
  /** True when the next row is a continuation of this one (soft-wrapped). */
  wrapsToNext: boolean;
}

const BLANK_END = /[ \t ]+$/;

/**
 * Builds clipboard text from selected screen rows:
 * - blanks at the end of every row are dropped (programs and tmux pad rows with spaces),
 * - rows that only continue because the line was too long for the screen are joined
 *   back into one line, so sentences flow; if the program padded the row before
 *   wrapping (it broke at a space), a single space is put between the words,
 * - real line breaks become CRLF, which Notepad and Word understand.
 */
export function joinSelectionRows(rows: SelRow[]): string {
  let out = '';
  for (let i = 0; i < rows.length; i++) {
    const prev = rows[i - 1];
    let text = rows[i].full.replace(BLANK_END, '');
    if (prev) {
      if (prev.wrapsToNext) {
        const prevPadded = BLANK_END.test(prev.full);
        if (prevPadded) {
          text = text.replace(/^[ \t ]+/, '');
          if (text && out && !/\s$/.test(out)) out += ' ';
        }
      } else {
        out += '\r\n';
      }
    }
    out += text;
  }
  return out.replace(/(\r\n)+$/, '');
}

/** Reads the current selection row by row from the terminal buffer. */
export function selectionText(term: Terminal): string {
  const pos = term.getSelectionPosition();
  if (!pos) return '';
  const buf = term.buffer.active;
  // xterm reports 0-based columns/rows here (despite its docs saying 1-based).
  const rows: SelRow[] = [];
  for (let y = pos.start.y; y <= pos.end.y; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const from = y === pos.start.y ? pos.start.x : 0;
    const to = y === pos.end.y ? pos.end.x : term.cols;
    const next = y < pos.end.y ? buf.getLine(y + 1) : undefined;
    rows.push({ full: line.translateToString(false, from, to), wrapsToNext: !!next?.isWrapped });
  }
  return joinSelectionRows(rows);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Mouse behaviour: dragging always selects locally (no Shift needed), even when
// tmux has mouse mode on. We do this by making xterm.js believe Shift is held
// for button events, which is its built-in "force selection" modifier.
// The wheel is NOT touched, so it still scrolls tmux history directly.
let dragging = false;
let dragPane: Pane | null = null;
function forceShift(e: MouseEvent) {
  if (!e.shiftKey) Object.defineProperty(e, 'shiftKey', { get: () => true });
}
function inTerm(e: Event): Pane | null {
  const host = (e.target as Element | null)?.closest?.('.term-host');
  return host ? termByEl.get(host) ?? null : null;
}
window.addEventListener('mousedown', e => {
  const p = inTerm(e);
  if (!p) return;
  if (e.button === 0 && e.detail === 1 && !e.shiftKey) p.term?.clearSelection();
  dragging = true;
  dragPane = p;
  forceShift(e);
}, true);
for (const type of ['mousemove', 'mouseup', 'click', 'dblclick'] as const) {
  window.addEventListener(type, e => {
    if (dragging || inTerm(e)) forceShift(e as MouseEvent);
    if (type === 'mouseup' && dragging) {
      dragging = false;
      const p = dragPane;
      dragPane = null;
      // Copy once the selection is final (after xterm handled this mouseup).
      // Covers drags, double-click (word) and triple-click (line) selection.
      if (p && store.settings.copyOnSelect) setTimeout(() => { if (p.term?.hasSelection()) p.copySelection(); }, 0);
    }
  }, true);
}
