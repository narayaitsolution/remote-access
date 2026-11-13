// A pane is one cell of the split layout: either the server picker or a terminal.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Close, Connect, Reconnect, Resize, Write, WriteBinary } from '../wailsjs/go/main/App';
import { ClipboardGetText, ClipboardSetText, EventsOn } from '../wailsjs/runtime/runtime';
import { askPassword, Picker } from './picker';
import { hooks, refreshState, store, type ProfileView } from './state';
import { errMsg, h } from './ui';

export type PaneState = 'picker' | 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'failed';

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
  private copyTimer = 0;

  constructor() {
    this.badge = h('div', { class: 'pane-badge hidden' });
    this.el = h('div', { class: 'pane' });
    this.el.addEventListener('mousedown', () => hooks.focusPane(this), true);
    this.ro = new ResizeObserver(() => this.refit());
    this.ro.observe(this.el);
    this.showPicker();
  }

  get connected() { return this.state === 'connected' && !!this.sessionId; }

  focus() {
    if (this.term) this.term.focus();
    else this.picker?.focus();
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
    term.onSelectionChange(() => {
      if (!store.settings.copyOnSelect) return;
      clearTimeout(this.copyTimer);
      this.copyTimer = window.setTimeout(() => this.copySelection(), 150);
    });
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
    if (!this.term) return;
    this.term.options.fontFamily = family;
    this.term.options.fontSize = size;
    this.refit();
  }

  copySelection() {
    if (!this.term) return;
    const text = cleanSelection(this.term.getSelection(), this.term.cols);
    if (text) ClipboardSetText(text);
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
    if (!p.hasPassword && !password) {
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
    this.ro.disconnect();
    this.teardownTerm();
    this.picker?.dispose();
    this.el.remove();
  }
}

/**
 * Turns a terminal selection into clean text for the Windows clipboard:
 * - trailing blanks on every line are removed (tmux pads lines with real spaces),
 * - a line that runs all the way to the right edge was wrapped by the screen width,
 *   so it is joined with the next line instead of getting a line break,
 * - line breaks become CRLF, which every Windows application understands.
 */
export function cleanSelection(sel: string, cols: number): string {
  if (!sel) return '';
  const lines = sel.split(/\r?\n/);
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const wrapped = raw.length >= cols && i < lines.length - 1;
    out += wrapped ? raw : raw.replace(/[ \t ]+$/, '');
    if (i < lines.length - 1 && !wrapped) out += '\r\n';
  }
  return out.replace(/(\r\n)+$/, '');
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
      if (p && store.settings.copyOnSelect) setTimeout(() => { if (p.term?.hasSelection()) p.copySelection(); }, 0);
    }
    if (type === 'dblclick') {
      const p = inTerm(e);
      if (p && store.settings.copyOnSelect) setTimeout(() => { if (p.term?.hasSelection()) p.copySelection(); }, 0);
    }
  }, true);
}
