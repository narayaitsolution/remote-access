// Tabs, split panes, focus handling and keyboard shortcuts.
import { SetUnsavedCount } from '../wailsjs/go/main/App';
import { WindowIsFullscreen, WindowFullscreen, WindowUnfullscreen } from '../wailsjs/runtime/runtime';
import { icons } from './icons';
import { Pane } from './pane';
import { hooks, saveSettingsSoon, store } from './state';
import type { Sidebar } from './sidebar';
import { h, isModalOpen } from './ui';

type Node = Leaf | Split;
interface Leaf { kind: 'leaf'; pane: Pane }
interface Split { kind: 'split'; dir: 'row' | 'col'; a: Node; b: Node; ratio: number }

class Tab {
  root: Node;
  active: Pane;
  el = h('div', { class: 'tab-content' });
  btn: HTMLDivElement;
  constructor(pane: Pane) {
    this.root = { kind: 'leaf', pane };
    this.active = pane;
    this.btn = h('div', { class: 'tab' });
  }
  panes(): Pane[] {
    const out: Pane[] = [];
    const walk = (n: Node): void => { n.kind === 'leaf' ? out.push(n.pane) : (walk(n.a), walk(n.b)); };
    walk(this.root);
    return out;
  }
}

export class Layout {
  private tabs: Tab[] = [];
  private cur!: Tab;
  private tabBar = h('div', { class: 'tabs' });
  private area = h('div', { class: 'tab-area' });
  el: HTMLElement;

  constructor(private sidebar: Sidebar) {
    const btn = (icon: string, title: string, fn: () => void) =>
      h('button', { class: 'icon-btn', title, html: icon, onclick: fn });
    const k = store.settings.keys;
    this.el = h('div', { class: 'layout' },
      h('div', { class: 'topbar' },
        btn(icons.sidebar, `Tampilkan/sembunyikan sidebar (${k.toggle_sidebar})`, () => this.toggleSidebar()),
        this.tabBar,
        btn(icons.plus, `Tab baru (${k.new_tab})`, () => this.newTab()),
        btn(icons.splitV, `Split vertikal (${k.split_vertical})`, () => this.split('row')),
        btn(icons.splitH, `Split horizontal (${k.split_horizontal})`, () => this.split('col')),
        h('button', { class: 'ai-toggle', title: `Asisten AI (${k.toggle_ai})`, onclick: () => hooks.toggleAI() }, 'AI')),
      this.area);

    // Editor panes share the connection of the terminal they came from.
    const target = (p: Pane) => p.editorSrc ?? p;
    hooks.paneChanged = p => {
      this.renderTabs();
      this.reportUnsaved();
      if (p === this.cur?.active) { this.sidebar.bind(target(p)); hooks.paneFocused(target(p)); }
    };
    hooks.openEditor = (src, path) => this.openEditor(src, path);
    hooks.closePane = p => this.closePane(p);
    hooks.focusPane = p => this.focusPane(p);
    hooks.activePane = () => this.cur?.active ?? null;
    hooks.allPanes = () => this.tabs.flatMap(t => t.panes());
    hooks.enterPressed = p => { if (p === this.cur?.active) this.sidebar.poke(); };

    window.addEventListener('keydown', e => this.onKey(e), true);
    window.addEventListener('wheel', e => this.onWheel(e), { capture: true, passive: false });
    this.newTab();
  }

  // ---------- tabs ----------
  newTab() {
    const tab = new Tab(new Pane());
    this.tabs.push(tab);
    this.area.append(tab.el);
    this.renderTree(tab);
    this.selectTab(tab);
  }

  private selectTab(tab: Tab) {
    this.cur = tab;
    for (const t of this.tabs) t.el.classList.toggle('hidden', t !== tab);
    this.renderTabs();
    this.focusPane(tab.active);
  }

  /** Opens a remote file in an editor tab (or switches to it if already open). */
  async openEditor(src: Pane, path: string) {
    for (const t of this.tabs) {
      const ed = t.panes().find(p => p.editor && p.editor.path === path && p.editor.sessionId === src.sessionId);
      if (ed) { this.focusPane(ed); return; }
    }
    const pane = new Pane(false);
    const tab = new Tab(pane);
    const i = this.tabs.indexOf(this.cur);
    this.tabs.splice(i + 1, 0, tab);
    this.area.append(tab.el);
    this.renderTree(tab);
    this.selectTab(tab);
    if (!(await pane.openEditor(src, path))) this.closeTab(tab, true);
  }

  private reportUnsaved() {
    const n = this.tabs.flatMap(t => t.panes()).filter(p => p.editor?.dirty).length;
    if (n !== this.lastUnsaved) { this.lastUnsaved = n; SetUnsavedCount(n); }
  }
  private lastUnsaved = 0;

  private async closeTab(tab: Tab, force = false) {
    if (!force) {
      for (const p of tab.panes()) {
        if (!(await p.canClose())) return;
      }
    }
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    tab.panes().forEach(p => p.dispose());
    tab.el.remove();
    this.tabs.splice(i, 1);
    this.reportUnsaved();
    if (this.tabs.length === 0) { this.newTab(); return; }
    if (tab === this.cur) this.selectTab(this.tabs[Math.min(i, this.tabs.length - 1)]);
    else this.renderTabs();
  }

  private renderTabs() {
    this.tabBar.innerHTML = '';
    for (const t of this.tabs) {
      const panes = t.panes();
      const p = t.active;
      const dot = h('span', { class: 'dot ' + p.state });
      const label = h('span', { class: 'tab-label', title: p.editor?.path ?? '' }, p.title + (panes.length > 1 ? ` (${panes.length})` : ''));
      const close = h('span', { class: 'tab-close', html: icons.x, title: 'Tutup tab' });
      close.addEventListener('click', e => { e.stopPropagation(); this.closeTab(t); });
      t.btn.className = 'tab' + (t === this.cur ? ' active' : '');
      t.btn.replaceChildren(dot, label, close);
      t.btn.onmousedown = e => { if (e.button === 1) { e.preventDefault(); this.closeTab(t); } };
      t.btn.onclick = () => this.selectTab(t);
      this.tabBar.append(t.btn);
    }
  }

  // ---------- splits ----------
  split(dir: 'row' | 'col') {
    const tab = this.cur;
    const target = tab.active;
    const pane = new Pane();
    const replace = (n: Node): Node => {
      if (n.kind === 'leaf') return n.pane === target ? { kind: 'split', dir, a: n, b: { kind: 'leaf', pane }, ratio: 0.5 } : n;
      return { ...n, a: replace(n.a), b: replace(n.b) };
    };
    tab.root = replace(tab.root);
    this.renderTree(tab);
    this.focusPane(pane);
  }

  async closePane(p: Pane) {
    const tab = this.tabs.find(t => t.panes().includes(p));
    if (!tab) return;
    if (tab.root.kind === 'leaf') { this.closeTab(tab); return; }
    if (!(await p.canClose())) return;
    let sibling: Node | null = null;
    const remove = (n: Node): Node => {
      if (n.kind === 'leaf') return n;
      if (n.a.kind === 'leaf' && n.a.pane === p) { sibling = n.b; return n.b; }
      if (n.b.kind === 'leaf' && n.b.pane === p) { sibling = n.a; return n.a; }
      return { ...n, a: remove(n.a), b: remove(n.b) };
    };
    tab.root = remove(tab.root);
    p.dispose();
    this.renderTree(tab);
    if (tab.active === p) {
      const first = (n: Node): Pane => n.kind === 'leaf' ? n.pane : first(n.a);
      tab.active = first(sibling ?? tab.root);
    }
    if (tab === this.cur) this.focusPane(tab.active);
    this.renderTabs();
  }

  private renderTree(tab: Tab) {
    const build = (n: Node): HTMLElement => {
      if (n.kind === 'leaf') { n.pane.el.style.flex = ''; return n.pane.el; }
      const a = build(n.a), b = build(n.b);
      const box = h('div', { class: 'split ' + n.dir });
      const gutter = h('div', { class: 'gutter ' + n.dir });
      const apply = () => {
        a.style.flex = `${n.ratio} 1 0`;
        b.style.flex = `${1 - n.ratio} 1 0`;
      };
      apply();
      gutter.addEventListener('mousedown', e => {
        e.preventDefault();
        const rect = box.getBoundingClientRect();
        const move = (ev: MouseEvent) => {
          const r = n.dir === 'row' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
          n.ratio = Math.min(0.9, Math.max(0.1, r));
          apply();
        };
        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.classList.remove('resizing'); };
        document.body.classList.add('resizing');
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });
      box.append(a, gutter, b);
      return box;
    };
    tab.el.replaceChildren(build(tab.root));
    tab.el.classList.toggle('multi', tab.root.kind === 'split');
    tab.panes().forEach(p => p.refit());
  }

  focusPane(p: Pane) {
    const tab = this.tabs.find(t => t.panes().includes(p));
    if (!tab) return;
    tab.active = p;
    if (tab !== this.cur) { this.selectTab(tab); return; }
    tab.panes().forEach(x => x.el.classList.toggle('active', x === p));
    this.renderTabs();
    this.sidebar.bind(p.editorSrc ?? p);
    hooks.paneFocused(p.editorSrc ?? p);
    p.focus();
  }

  private focusDir(dx: number, dy: number) {
    const from = this.cur.active.el.getBoundingClientRect();
    const cx = from.left + from.width / 2, cy = from.top + from.height / 2;
    let best: Pane | null = null, bestD = Infinity;
    for (const p of this.cur.panes()) {
      if (p === this.cur.active) continue;
      const r = p.el.getBoundingClientRect();
      const ok = dx > 0 ? r.left >= from.right - 2 : dx < 0 ? r.right <= from.left + 2 :
        dy > 0 ? r.top >= from.bottom - 2 : r.bottom <= from.top + 2;
      if (!ok) continue;
      const d = Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best) this.focusPane(best);
  }

  toggleSidebar() {
    store.settings.sidebarVisible = !store.settings.sidebarVisible;
    this.sidebar.applyVisibility();
    saveSettingsSoon();
    setTimeout(() => this.cur.panes().forEach(p => p.refit()), 0);
  }

  // ---------- keyboard ----------
  private onKey(e: KeyboardEvent) {
    if (isModalOpen()) return;
    const k = store.settings.keys;
    const is = (name: string) => matchKey(e, k[name]);
    let handled = true;
    const p = this.cur.active;
    if (is('new_tab')) this.newTab();
    else if (is('split_vertical')) this.split('row');
    else if (is('split_horizontal')) this.split('col');
    else if (is('close_pane')) this.closePane(p);
    else if (is('next_tab')) this.cycleTab(1);
    else if (is('prev_tab')) this.cycleTab(-1);
    else if (is('focus_left')) this.focusDir(-1, 0);
    else if (is('focus_right')) this.focusDir(1, 0);
    else if (is('focus_up')) this.focusDir(0, -1);
    else if (is('focus_down')) this.focusDir(0, 1);
    else if (is('toggle_sidebar')) this.toggleSidebar();
    else if (is('copy')) p.copySelection();
    else if (is('paste')) p.paste();
    else if (is('fullscreen')) this.toggleFullscreen();
    else if (is('toggle_ai')) hooks.toggleAI();
    else if (p.editor && e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') p.editor.save();
    else if (e.ctrlKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      const t = this.tabs[Number(e.key) - 1];
      if (t) this.selectTab(t);
    } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === '0') this.setFontSize(14);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  private cycleTab(d: number) {
    const i = this.tabs.indexOf(this.cur);
    this.selectTab(this.tabs[(i + d + this.tabs.length) % this.tabs.length]);
  }

  private async toggleFullscreen() {
    if (await WindowIsFullscreen()) WindowUnfullscreen(); else WindowFullscreen();
  }

  private onWheel(e: WheelEvent) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    this.setFontSize(store.settings.fontSize + (e.deltaY < 0 ? 1 : -1));
  }

  private setFontSize(size: number) {
    size = Math.max(8, Math.min(32, size));
    store.settings.fontSize = size;
    for (const p of hooks.allPanes()) p.setFont(store.settings.fontFamily, size);
    saveSettingsSoon();
  }
}

/** Matches "Ctrl+Shift+T", "Alt+Left", "F11", "Ctrl+Tab" style strings. */
export function matchKey(e: KeyboardEvent, spec: string | undefined): boolean {
  if (!spec) return false;
  const parts = spec.split('+').map(s => s.trim().toLowerCase());
  const key = parts.pop()!;
  const want = { ctrl: parts.includes('ctrl'), shift: parts.includes('shift'), alt: parts.includes('alt') };
  if (e.ctrlKey !== want.ctrl || e.shiftKey !== want.shift || e.altKey !== want.alt) return false;
  const aliases: Record<string, string> = {
    left: 'arrowleft', right: 'arrowright', up: 'arrowup', down: 'arrowdown',
    plus: '+', minus: '-', space: ' ', esc: 'escape', del: 'delete',
  };
  const k = aliases[key] ?? key;
  if (e.key.toLowerCase() === k) return true;
  // With Shift held e.key changes (e.g. "!" for 1), so fall back to the physical key.
  if (k.length === 1) return e.code.toLowerCase() === (/[a-z]/.test(k) ? 'key' + k : 'digit' + k);
  return false;
}
