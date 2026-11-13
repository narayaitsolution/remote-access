// AI assistant panel. The AI CLI (Claude Code / Codex) runs locally with the
// user's own login; its tool calls arrive here, are shown to the user, need
// approval when they change something, and are executed in the visible terminal.
import {
  AIProviders, AIReset, AISend, AIStop, AIToolResult, CaptureTmux, Info, ListDir, ReadFileText, WriteFileText,
} from '../wailsjs/go/main/App';
import { EventsOn } from '../wailsjs/runtime/runtime';
import type { Pane } from './pane';
import { hooks, saveSettingsSoon, store } from './state';
import { esc, fmtSize, h, promptText, toast } from './ui';

interface ProviderInfo { id: string; name: string; installed: boolean; models: string[]; defaultModel: string }

type ToolStatus = 'approval' | 'running' | 'done' | 'denied' | 'error' | 'cancelled';
type Item =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'note'; text: string; error?: boolean }
  | { kind: 'tool'; reqId: string; name: string; args: any; status: ToolStatus; output: string; open: boolean };

interface Usage { input: number; cached: number; output: number; cost: number; turns: number }

interface Chat {
  id: string;
  pane: Pane;
  provider: string;
  items: Item[];
  busy: boolean;
  autoApprove: boolean;
  usage: Usage;
  lastCost: number;
}

interface RateWindow { utilization: number; resetsAt: number }

const MUTATING = new Set(['run_command', 'send_keys', 'write_file']);
const TOOL_LABEL: Record<string, string> = {
  read_screen: 'Membaca layar', run_command: 'Menjalankan perintah', send_keys: 'Mengirim tombol',
  list_dir: 'Melihat folder', read_file: 'Membaca file', write_file: 'Menulis file',
};

let chatSeq = 0;

export class AIPanel {
  el: HTMLElement;
  private providers: ProviderInfo[] = [];
  private chats = new Map<Pane, Chat>();
  private byId = new Map<string, Chat>();
  private pane: Pane | null = null;
  private providerSel: HTMLSelectElement;
  private modelSel: HTMLSelectElement;
  private target: HTMLElement;
  private usageEl: HTMLElement;
  private list: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private autoChk: HTMLInputElement;
  private limits: Record<string, RateWindow> = {};
  private approvals = new Map<string, (ok: boolean | 'all') => void>();

  constructor() {
    this.providerSel = h('select', { class: 'ai-select', title: 'Penyedia AI' });
    this.modelSel = h('select', { class: 'ai-select', title: 'Model' });
    this.providerSel.addEventListener('change', () => this.onProviderChange());
    this.modelSel.addEventListener('change', () => this.onModelChange());
    this.target = h('div', { class: 'ai-target' });
    this.usageEl = h('div', { class: 'ai-usage' });
    this.list = h('div', { class: 'ai-list' });
    this.input = h('textarea', { class: 'ai-input', rows: 3, placeholder: 'Minta AI membantu di terminal ini…  (Enter kirim · Shift+Enter baris baru)' });
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
    });
    this.sendBtn = h('button', { class: 'btn primary ai-send', onclick: () => this.busy() ? this.stop() : this.send() }, 'Kirim');
    this.autoChk = h('input', { type: 'checkbox' });
    this.autoChk.addEventListener('change', () => {
      const c = this.chat();
      if (c) c.autoApprove = this.autoChk.checked;
    });
    const newBtn = h('button', { class: 'btn small', title: 'Mulai percakapan baru', onclick: () => this.newChat() }, 'Chat baru');
    const closeBtn = h('button', { class: 'icon-btn', title: 'Tutup panel AI (Ctrl+Shift+A)', html: '&times;', onclick: () => this.toggle(false) });
    const resizer = h('div', { class: 'ai-resizer' });
    this.el = h('div', { class: 'ai-panel' },
      resizer,
      h('div', { class: 'ai-head' },
        h('span', { class: 'ai-title' }, 'AI'), this.providerSel, this.modelSel, h('span', { class: 'ai-spacer' }), newBtn, closeBtn),
      this.target, this.usageEl, this.list,
      h('div', { class: 'ai-foot' },
        this.input,
        h('div', { class: 'ai-foot-row' },
          h('label', { class: 'ai-auto', title: 'Jika dicentang, perintah AI di chat ini dijalankan tanpa bertanya' }, this.autoChk, 'Izinkan semua di chat ini'),
          this.sendBtn)));
    this.setupResize(resizer);
    this.applyVisibility();

    EventsOn('ai:tool', (ev: { reqId: string; chatId: string; name: string; args: any }) => this.onTool(ev));
    EventsOn('ai:toolCancel', (reqId: string) => this.onToolCancel(reqId));
    this.init();
  }

  private async init() {
    this.providers = (await AIProviders()) as unknown as ProviderInfo[];
    const s = store.settings;
    s.aiModels = s.aiModels || {};
    this.providerSel.replaceChildren(...this.providers.map(p =>
      h('option', { value: p.id, disabled: !p.installed }, p.name + (p.installed ? '' : ' (tidak terpasang)'))));
    const usable = this.providers.find(p => p.id === s.aiProvider && p.installed) || this.providers.find(p => p.installed);
    if (usable) this.providerSel.value = usable.id;
    this.fillModels();
    this.render();
  }

  // ---------- panel chrome ----------
  applyVisibility() {
    this.el.classList.toggle('hidden', !store.settings.aiVisible);
    this.el.style.width = (store.settings.aiWidth || 400) + 'px';
  }

  toggle(show = !store.settings.aiVisible) {
    store.settings.aiVisible = show;
    this.applyVisibility();
    saveSettingsSoon();
    setTimeout(() => hooks.allPanes().forEach(p => p.refit()), 0);
    if (show) setTimeout(() => this.input.focus(), 0);
    else hooks.activePane()?.focus();
  }

  private setupResize(handle: HTMLElement) {
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      const startX = e.clientX, startW = this.el.offsetWidth;
      const move = (ev: MouseEvent) => {
        store.settings.aiWidth = Math.max(280, Math.min(900, startW - (ev.clientX - startX)));
        this.el.style.width = store.settings.aiWidth + 'px';
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

  private provider(): string { return this.providerSel.value || 'claude'; }

  private fillModels() {
    const p = this.providers.find(x => x.id === this.provider());
    if (!p) return;
    const chosen = store.settings.aiModels[p.id] || p.defaultModel;
    const models = [...p.models];
    if (chosen && !models.includes(chosen)) models.unshift(chosen);
    this.modelSel.replaceChildren(
      ...models.map(m => h('option', { value: m }, m || '(default)')),
      h('option', { value: '__custom' }, 'Model lain…'));
    this.modelSel.value = chosen;
  }

  private onProviderChange() {
    store.settings.aiProvider = this.provider();
    saveSettingsSoon();
    this.fillModels();
    const c = this.chat();
    if (c && c.items.length && c.provider !== this.provider()) {
      this.note(c, `Penyedia diganti ke ${this.providerName()}. Percakapan baru dimulai untuk penyedia ini.`);
    }
    this.render();
  }

  private async onModelChange() {
    let m = this.modelSel.value;
    if (m === '__custom') {
      const v = await promptText('Model lain', `Nama model untuk ${this.providerName()}`);
      if (!v) { this.fillModels(); return; }
      m = v;
    }
    store.settings.aiModels[this.provider()] = m;
    saveSettingsSoon();
    this.fillModels();
  }

  private providerName() { return this.providers.find(p => p.id === this.provider())?.name || this.provider(); }

  // ---------- chats ----------
  /** Called when the focused pane changes. */
  bind(p: Pane) {
    this.pane = p;
    this.render();
  }

  private chat(create = false): Chat | null {
    const p = this.pane;
    if (!p) return null;
    let c = this.chats.get(p);
    if (!c && create) {
      c = { id: `c${++chatSeq}`, pane: p, provider: this.provider(), items: [], busy: false, autoApprove: false,
        usage: { input: 0, cached: 0, output: 0, cost: 0, turns: 0 }, lastCost: 0 };
      this.chats.set(p, c);
      this.byId.set(c.id, c);
      this.listen(c);
    }
    return c ?? null;
  }

  private listen(c: Chat) {
    EventsOn('ai:line:' + c.id, (line: string) => this.onLine(c, line));
    EventsOn('ai:state:' + c.id, (st: { running: boolean; error?: string; stopped?: boolean }) => {
      if (!st.running) {
        if (st.error) this.note(c, 'AI berhenti: ' + st.error, true);
        if (st.stopped) this.note(c, 'Dihentikan.');
        this.setBusy(c, false);
      }
    });
  }

  private busy() { return !!this.chat()?.busy; }

  private setBusy(c: Chat, busy: boolean) {
    c.busy = busy;
    c.pane.el.classList.toggle('ai-active', busy);
    if (!busy) this.paneStatus(c, '');
    else this.paneStatus(c, 'AI sedang bekerja…');
    hooks.paneChanged(c.pane);
    if (c === this.chat()) this.render();
  }

  newChat() {
    const c = this.chat();
    if (!c) return;
    AIReset(c.id);
    this.chats.delete(c.pane);
    this.byId.delete(c.id);
    c.pane.el.classList.remove('ai-active');
    this.render();
    this.input.focus();
  }

  /** Forget the chat of a pane that is being closed. */
  disposePane(p: Pane) {
    const c = this.chats.get(p);
    if (!c) return;
    AIReset(c.id);
    this.chats.delete(p);
    this.byId.delete(c.id);
  }

  private async send() {
    const text = this.input.value.trim();
    if (!text) return;
    const p = this.pane;
    if (!p || !p.connected || !p.profile) { toast('Hubungkan terminal ke server dulu', 'error'); return; }
    const c = this.chat(true)!;
    if (c.busy && this.provider() === 'codex') { toast('Codex masih bekerja'); return; }
    if (c.provider !== this.provider()) { AIReset(c.id); c.provider = this.provider(); }
    this.input.value = '';
    c.items.push({ kind: 'user', text });
    this.setBusy(c, true);
    const prof = p.profile;
    const context = `Server: "${prof.name}" — ${prof.user}@${prof.host}:${prof.port}.`;
    let live = '';
    try {
      const info = await Info(p.sessionId);
      live = `[Terminal saat ini: ${info.tmux ? `di dalam tmux session "${info.tmux}"` : 'shell biasa (tanpa tmux)'}, folder: ${info.cwd || '?'}]\n`;
    } catch { /* not critical */ }
    try {
      await AISend(c.id, c.provider, store.settings.aiModels[c.provider] || this.modelSel.value || '', live + text, context);
    } catch (e) {
      this.note(c, 'Gagal mengirim: ' + String(e), true);
      this.setBusy(c, false);
    }
  }

  private stop() {
    const c = this.chat();
    if (!c) return;
    AIStop(c.id);
    for (const [reqId, resolve] of this.approvals) {
      const item = this.findTool(reqId);
      if (item && item.chat === c) resolve(false);
    }
  }

  private note(c: Chat, text: string, error = false) {
    c.items.push({ kind: 'note', text, error });
    if (c === this.chat()) this.render();
  }

  // ---------- CLI output ----------
  private onLine(c: Chat, line: string) {
    let ev: any;
    try { ev = JSON.parse(line); } catch { return; }
    if (c.provider === 'claude') this.onClaude(c, ev); else this.onCodex(c, ev);
    if (c === this.chat()) this.render();
  }

  private onClaude(c: Chat, ev: any) {
    switch (ev.type) {
      case 'assistant':
        for (const part of ev.message?.content || []) {
          if (part.type === 'text' && part.text?.trim()) c.items.push({ kind: 'text', text: part.text });
        }
        break;
      case 'rate_limit_event': {
        const w = ev.rate_limit_info?.unifiedWindows || {};
        for (const k of Object.keys(w)) this.limits[k] = { utilization: w[k].utilization, resetsAt: w[k].resetsAt };
        break;
      }
      case 'result': {
        const u = ev.usage || {};
        c.usage.input += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        c.usage.cached += u.cache_read_input_tokens || 0;
        c.usage.output += u.output_tokens || 0;
        c.usage.turns++;
        const cost = Number(ev.total_cost_usd || 0);
        // total_cost_usd may be cumulative for the running process; count only the increase.
        c.usage.cost += cost >= c.lastCost ? cost - c.lastCost : cost;
        c.lastCost = cost;
        if (ev.is_error && ev.result) this.note(c, String(ev.result), true);
        this.setBusy(c, false);
        break;
      }
    }
  }

  private onCodex(c: Chat, ev: any) {
    switch (ev.type) {
      case 'item.completed': {
        const it = ev.item || {};
        if (it.type === 'agent_message' && it.text) c.items.push({ kind: 'text', text: it.text });
        else if (it.type === 'command_execution') this.note(c, `Codex menjalankan perintah di komputer lokal (bukan server): ${it.command}`, true);
        else if (it.type === 'mcp_tool_call' && it.status === 'failed' && it.error?.message) this.note(c, 'Alat gagal: ' + it.error.message, true);
        else if (it.type === 'error' && it.message) this.note(c, it.message, true);
        break;
      }
      case 'turn.completed': {
        const u = ev.usage || {};
        c.usage.input += Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0));
        c.usage.cached += u.cached_input_tokens || 0;
        c.usage.output += (u.output_tokens || 0);
        c.usage.turns++;
        break;
      }
      case 'turn.failed':
      case 'error':
        this.note(c, ev.error?.message || ev.message || 'Codex error', true);
        break;
    }
  }

  // ---------- tool calls ----------
  private findTool(reqId: string): { chat: Chat; item: Extract<Item, { kind: 'tool' }> } | null {
    for (const c of this.byId.values()) {
      for (const it of c.items) if (it.kind === 'tool' && it.reqId === reqId) return { chat: c, item: it };
    }
    return null;
  }

  private onToolCancel(reqId: string) {
    this.approvals.get(reqId)?.(false);
    const f = this.findTool(reqId);
    if (f && (f.item.status === 'running' || f.item.status === 'approval')) {
      f.item.status = 'cancelled';
      if (f.chat === this.chat()) this.render();
    }
  }

  private async onTool(ev: { reqId: string; chatId: string; name: string; args: any }) {
    const c = this.byId.get(ev.chatId);
    const reply = (text: string, isError = false) => AIToolResult(ev.reqId, isError, text);
    if (!c) { reply('Chat tidak ditemukan', true); return; }
    const args = typeof ev.args === 'string' ? JSON.parse(ev.args || '{}') : (ev.args || {});
    const item: Extract<Item, { kind: 'tool' }> = { kind: 'tool', reqId: ev.reqId, name: ev.name, args, status: 'running', output: '', open: false };
    c.items.push(item);
    const p = c.pane;
    if (!p.connected || !p.term) {
      item.status = 'error'; item.output = 'Terminal tidak terhubung';
      this.refresh(c);
      reply('The terminal is not connected to the server right now.', true);
      return;
    }
    if (MUTATING.has(ev.name) && !c.autoApprove) {
      item.status = 'approval';
      this.refresh(c);
      if (!store.settings.aiVisible) this.toggle(true);
      const decision = await this.askApproval(c, item);
      if ((item.status as ToolStatus) === 'cancelled') return; // CLI gave up meanwhile
      if (decision === false) {
        item.status = 'denied';
        this.refresh(c);
        reply('The user denied this action. Do not retry it; ask the user how to proceed.', true);
        return;
      }
      if (decision === 'all') { c.autoApprove = true; this.autoChk.checked = true; }
      item.status = 'running';
    }
    this.paneStatus(c, `AI: ${TOOL_LABEL[ev.name] || ev.name}${ev.name === 'run_command' ? ' — ' + String(args.command).slice(0, 80) : ''}`);
    this.refresh(c);
    try {
      const out = await this.execTool(p, ev.name, args);
      item.status = 'done';
      item.output = out;
      reply(out || '(no output)');
    } catch (e) {
      item.status = 'error';
      item.output = String((e as any)?.message ?? e);
      reply(item.output, true);
    }
    this.paneStatus(c, c.busy ? 'AI sedang bekerja…' : '');
    this.refresh(c);
  }

  private refresh(c: Chat) { if (c === this.chat()) this.render(); }

  /** Approval shown both in the panel and on the terminal itself. */
  private askApproval(c: Chat, item: Extract<Item, { kind: 'tool' }>): Promise<boolean | 'all'> {
    return new Promise(resolve => {
      const bar = h('div', { class: 'ai-approve-bar' },
        h('div', { class: 'ai-approve-title' }, `AI meminta izin: ${TOOL_LABEL[item.name] || item.name}`),
        h('pre', { class: 'ai-approve-cmd' }, summarize(item.name, item.args, 600)),
        h('div', { class: 'ai-approve-btns' },
          h('button', { class: 'btn', onclick: () => done(false) }, 'Tolak'),
          h('button', { class: 'btn', onclick: () => done('all') }, 'Izinkan semua'),
          h('button', { class: 'btn primary', onclick: () => done(true) }, 'Izinkan')));
      c.pane.el.append(bar);
      this.paneStatus(c, 'AI menunggu izin Anda');
      const done = (v: boolean | 'all') => {
        this.approvals.delete(item.reqId);
        bar.remove();
        resolve(v);
      };
      this.approvals.set(item.reqId, done);
    });
  }

  private paneStatus(c: Chat, text: string) {
    let badge = c.pane.el.querySelector<HTMLElement>('.ai-badge');
    if (!text) { badge?.remove(); return; }
    if (!badge) { badge = h('div', { class: 'ai-badge' }); c.pane.el.append(badge); }
    badge.textContent = text;
  }

  private async execTool(p: Pane, name: string, a: any): Promise<string> {
    switch (name) {
      case 'read_screen': return readScreen(p, clamp(Number(a.history_lines) || 0, 0, 2000));
      case 'run_command': return runCommand(p, String(a.command || ''), clamp(Number(a.timeout_seconds) || 60, 5, 600));
      case 'send_keys': {
        p.send(parseKeys(String(a.keys || '')));
        await sleep(800);
        return 'Keys sent. Screen now:\n' + await readScreen(p, 0);
      }
      case 'list_dir': {
        const res = await ListDir(p.sessionId, String(a.path || '~'));
        const rows = (res.entries || []).map((e: any) =>
          `${e.isDir ? 'd' : '-'} ${e.mode} ${String(e.isDir ? '' : fmtSize(e.size)).padStart(8)}  ${new Date(e.modTime * 1000).toISOString().slice(0, 16)}  ${e.name}${e.isDir ? '/' : ''}`);
        return `${res.path}\n${rows.join('\n') || '(kosong)'}`;
      }
      case 'read_file': return ReadFileText(p.sessionId, String(a.path), Number(a.max_bytes) || 200000);
      case 'write_file': {
        await WriteFileText(p.sessionId, String(a.path), String(a.content ?? ''));
        hooks.filesChanged();
        return `Wrote ${String(a.content ?? '').length} characters to ${a.path}`;
      }
    }
    throw new Error('Unknown tool ' + name);
  }

  // ---------- rendering ----------
  render() {
    const p = this.pane;
    const c = this.chat();
    this.target.textContent = p?.profile
      ? `Bekerja di: ${p.title} (${p.profile.user}@${p.profile.host})${p.connected ? '' : ' — tidak terhubung'}`
      : 'Pilih/hubungkan server di terminal dulu.';
    this.autoChk.checked = !!c?.autoApprove;
    this.sendBtn.textContent = c?.busy ? 'Stop' : 'Kirim';
    this.sendBtn.classList.toggle('danger', !!c?.busy);
    this.renderUsage(c);

    const nodes: HTMLElement[] = [];
    if (!c || c.items.length === 0) {
      nodes.push(h('div', { class: 'ai-empty', html: `
        <b>Asisten AI untuk terminal ini</b><br>
        AI bisa membaca layar, menjalankan perintah langsung di terminal (Anda bisa memantaunya), mengirim tombol, serta membaca/menulis file.
        Setiap tindakan yang mengubah sesuatu meminta izin Anda dulu.<br><br>
        Contoh: <i>"kenapa service nginx gagal start?"</i>, <i>"cek disk mana yang hampir penuh"</i>, <i>"jelaskan error di layar"</i>.` }));
    } else {
      for (const it of c.items) nodes.push(this.renderItem(it));
      if (c.busy) nodes.push(h('div', { class: 'ai-thinking' }, h('span', { class: 'ai-dots' }), 'AI sedang bekerja…'));
    }
    const atBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;
    this.list.replaceChildren(...nodes);
    if (atBottom || c?.busy) this.list.scrollTop = this.list.scrollHeight;
  }

  private renderUsage(c: Chat | null) {
    const parts: string[] = [];
    if (this.provider() === 'claude') {
      const lim = (k: string, label: string) => {
        const w = this.limits[k];
        if (!w) return '';
        const pct = Math.round(w.utilization * 100);
        const cls = pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : '';
        return `<span class="${cls}" title="Reset ${new Date(w.resetsAt * 1000).toLocaleString()}">${label} ${pct}%</span>`;
      };
      const l5 = lim('five_hour', 'Limit 5 jam'), l7 = lim('seven_day', '7 hari');
      parts.push(l5 || l7 ? [l5, l7].filter(Boolean).join(' · ') : '<span class="muted">Limit langganan muncul setelah pesan pertama</span>');
    } else {
      parts.push('<span class="muted">Codex tidak melaporkan sisa limit</span>');
    }
    if (c && c.usage.turns) {
      const k = (n: number) => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
      let s = `Chat ini: ${k(c.usage.input)} masuk${c.usage.cached ? ` (+${k(c.usage.cached)} cache)` : ''} · ${k(c.usage.output)} keluar`;
      if (c.provider === 'claude' && c.usage.cost) s += ` · ≈$${c.usage.cost.toFixed(3)}`;
      parts.push(s);
    }
    this.usageEl.innerHTML = parts.join('<br>');
  }

  private renderItem(it: Item): HTMLElement {
    switch (it.kind) {
      case 'user': return h('div', { class: 'ai-msg user' }, it.text);
      case 'text': return h('div', { class: 'ai-msg bot', html: markdown(it.text) });
      case 'note': return h('div', { class: 'ai-note' + (it.error ? ' error' : '') }, it.text);
      case 'tool': {
        const statusText: Record<ToolStatus, string> = {
          approval: 'menunggu izin', running: 'berjalan…', done: 'selesai', denied: 'ditolak', error: 'gagal', cancelled: 'dibatalkan',
        };
        const head = h('div', { class: 'ai-tool-head' },
          h('span', { class: 'ai-tool-name' }, TOOL_LABEL[it.name] || it.name),
          h('span', { class: 'ai-tool-status ' + it.status }, statusText[it.status]));
        const box = h('div', { class: 'ai-tool ' + it.status }, head,
          h('pre', { class: 'ai-tool-args' }, summarize(it.name, it.args, 300)));
        if (it.status === 'approval') {
          const resolve = this.approvals.get(it.reqId);
          box.append(h('div', { class: 'ai-approve-btns' },
            h('button', { class: 'btn', onclick: () => resolve?.(false) }, 'Tolak'),
            h('button', { class: 'btn', onclick: () => resolve?.('all') }, 'Izinkan semua'),
            h('button', { class: 'btn primary', onclick: () => resolve?.(true) }, 'Izinkan')));
        }
        if (it.output) {
          const out = h('pre', { class: 'ai-tool-out' + (it.open ? '' : ' collapsed') }, it.output.length > 20000 ? it.output.slice(-20000) : it.output);
          const toggle = h('button', { class: 'link' }, it.open ? 'Sembunyikan hasil' : 'Lihat hasil');
          toggle.onclick = () => { it.open = !it.open; this.render(); };
          box.append(toggle, out);
        }
        return box;
      }
    }
  }
}

// ---------- terminal helpers ----------

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function summarize(name: string, a: any, max: number): string {
  let s: string;
  switch (name) {
    case 'run_command': s = String(a.command ?? ''); break;
    case 'send_keys': s = String(a.keys ?? ''); break;
    case 'write_file': s = `${a.path}\n────\n${String(a.content ?? '')}`; break;
    case 'read_file': case 'list_dir': s = String(a.path ?? ''); break;
    case 'read_screen': s = a.history_lines ? `layar + ${a.history_lines} baris riwayat` : 'layar saat ini'; break;
    default: s = JSON.stringify(a);
  }
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** Logical lines (wrapped rows joined) of the terminal buffer from row `from`. */
function bufferLines(p: Pane, from: number, to: number): string[] {
  const buf = p.term!.buffer.active;
  const out: string[] = [];
  for (let y = Math.max(0, from); y < Math.min(to, buf.length); y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && out.length) out[out.length - 1] += text;
    else out.push(text);
  }
  return out;
}

async function inTmux(p: Pane): Promise<boolean> {
  try { return !!(await Info(p.sessionId)).tmux; } catch { return false; }
}

async function readScreen(p: Pane, history: number): Promise<string> {
  const term = p.term!;
  const buf = term.buffer.active;
  if (history > 0 && await inTmux(p)) {
    try {
      const all = (await CaptureTmux(p.sessionId, history + term.rows)).replace(/\n+$/, '');
      return all.split('\n').slice(-(history + term.rows)).join('\n');
    } catch { /* fall back to local buffer */ }
  }
  const start = buf.viewportY - history;
  const lines = bufferLines(p, start, buf.viewportY + term.rows);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n') + `\n[cursor at row ${buf.cursorY + 1}, col ${buf.cursorX + 1}; ${term.cols}x${term.rows}]`;
}

/**
 * Types the command into the visible terminal followed by a marker that prints
 * the exit code, waits for the marker and returns the output in between.
 */
async function runCommand(p: Pane, command: string, timeoutSec: number): Promise<string> {
  command = command.replace(/\s+$/, '');
  if (!command) throw new Error('empty command');
  if (command.includes('\n')) throw new Error('run_command takes a single line; join commands with && or ; (or write a script with write_file).');
  const id = Math.random().toString(36).slice(2, 8);
  const done = new RegExp(`__RTDONE_${id}_(\\d+)`);
  const echoTag = `'DONE_${id}'`;
  p.send(`${command}; printf '\\n%s%s_%s\\n' '__RT' ${echoTag} "$?"\r`);
  const deadline = Date.now() + timeoutSec * 1000;
  const term = p.term!;
  let code: string | null = null;
  while (Date.now() < deadline) {
    await sleep(250);
    if (!p.term) throw new Error('terminal closed');
    const buf = term.buffer.active;
    const lines = bufferLines(p, buf.baseY + buf.cursorY - term.rows - 5, buf.baseY + term.rows + 1);
    for (const l of lines) { const m = done.exec(l); if (m) code = m[1]; }
    if (code !== null) break;
  }
  if (code === null) {
    return `Command still running after ${timeoutSec}s (it keeps running in the user's terminal). Current screen:\n` + await readScreen(p, 0);
  }
  // Collect output: tmux history is complete; otherwise use the local scrollback.
  let lines: string[] = [];
  if (await inTmux(p)) {
    try { lines = (await CaptureTmux(p.sessionId, 3000)).split('\n'); } catch { /* ignore */ }
  }
  if (!lines.some(l => done.test(l))) {
    const buf = term.buffer.active;
    lines = bufferLines(p, 0, buf.length);
  }
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (done.test(lines[i])) { end = i; break; }
  let start = -1;
  for (let i = end - 1; i >= 0; i--) if (lines[i].includes(echoTag)) { start = i; break; }
  let output = lines.slice(start + 1, end).join('\n').replace(/\n+$/, '');
  if (output.length > 30000) output = '[... output awal dipotong]\n' + output.slice(-30000);
  return `exit code: ${code}\n${output || '(no output)'}`;
}

const KEYMAP: Record<string, string> = {
  enter: '\r', tab: '\t', esc: '\x1b', escape: '\x1b', backspace: '\x7f', space: ' ',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  home: '\x1b[H', end: '\x1b[F', pageup: '\x1b[5~', pagedown: '\x1b[6~', delete: '\x1b[3~',
};

export function parseKeys(s: string): string {
  return s.replace(/<([^<>]+)>/g, (whole, name: string) => {
    const k = name.trim().toLowerCase();
    if (KEYMAP[k] !== undefined) return KEYMAP[k];
    const ctrl = /^(?:ctrl|c)-([a-z@\[\\\]^_])$/.exec(k);
    if (ctrl) return String.fromCharCode(ctrl[1].toUpperCase().charCodeAt(0) & 0x1f);
    return whole;
  });
}

/** Very small Markdown subset: code blocks, inline code, bold, lists, paragraphs. */
function markdown(src: string): string {
  const blocks = src.split(/```/);
  return blocks.map((b, i) => {
    if (i % 2 === 1) {
      const code = b.replace(/^[a-zA-Z0-9_-]*\n/, '');
      return `<pre class="ai-code">${esc(code.replace(/\n$/, ''))}</pre>`;
    }
    return esc(b)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/^#{1,6} (.+)$/gm, '<b>$1</b>')
      .replace(/^\s*[-*] (.+)$/gm, '• $1')
      .replace(/\n/g, '<br>');
  }).join('');
}
