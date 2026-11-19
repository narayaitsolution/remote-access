// AI assistant panel. The AI CLI (Claude Code / Codex) runs locally with the
// user's own login; its tool calls arrive here, are shown to the user, need
// approval when they change something, and are executed in the visible terminal.
import { t } from './i18n';
import {
  AIProviders, AIReset, DeleteAIProvider, ListAIProviders, SaveAIProvider, TestAIProvider, AISend, AIStop, AIToolResult, CaptureTmux, Info, ListDir, ReadFileText, RunHidden, WriteFileText,
} from '../wailsjs/go/main/App';
import { dangerReason } from './agent';
import { invalidateCompanionProviders } from './companion';
import { EventsOn } from '../wailsjs/runtime/runtime';
import type { Pane } from './pane';
import { hooks, saveSettingsSoon, store } from './state';
import { confirmDialog, errMsg, esc, fmtSize, h, openModal, promptText, toast } from './ui';
import { main } from '../wailsjs/go/models';

interface ProviderInfo { id: string; name: string; installed: boolean; models: string[]; defaultModel: string; kind: string }

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
  autoRead: boolean;
  autoWrite: boolean;
  /** Terminal the AI tools act on (T1 = pane, or one the AI opened). */
  work: Pane;
  /** T1, T2, … — the chat's own terminal first, then those opened by the AI. */
  terminals: Pane[];
  usage: Usage;
  lastCost: number;
}

interface RateWindow { utilization: number; resetsAt: number }

/** Tools that only look; everything else changes something. Both need permission. */
const READ_TOOLS = new Set(['read_screen', 'wait_for_screen', 'list_dir', 'read_file', 'open_file', 'use_terminal']);
const TOOL_LABEL: Record<string, string> = {
  read_screen: 'Membaca layar', run_command: 'Menjalankan perintah di terminal', send_keys: 'Mengetik ke layar',
  run_background: 'Menjalankan perintah (latar belakang)',
  wait_for_screen: 'Memantau layar', list_dir: 'Melihat folder', read_file: 'Membaca file', write_file: 'Menulis file',
  open_file: 'Membuka file di editor', edit_file: 'Mengedit file', open_terminal: 'Membuka terminal baru', use_terminal: 'Berpindah terminal',
};
const toolLabel = (name: string) => TOOL_LABEL[name] ? t(TOOL_LABEL[name]) : name;
const SHELLS = new Set(['bash', 'sh', 'dash', 'zsh', 'fish', 'ksh', 'tcsh', 'csh', 'ash', '-bash', '-sh', '-zsh']);

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
  private agentChk: HTMLInputElement;
  private limits: Record<string, RateWindow> = {};
  private approvals = new Map<string, (ok: boolean | 'all') => void>();

  constructor() {
    this.providerSel = h('select', { class: 'ai-select', title: t('Penyedia AI') });
    this.modelSel = h('select', { class: 'ai-select', title: 'Model' });
    this.providerSel.addEventListener('change', () => this.onProviderChange());
    this.modelSel.addEventListener('change', () => this.onModelChange());
    this.target = h('div', { class: 'ai-target' });
    this.usageEl = h('div', { class: 'ai-usage' });
    this.list = h('div', { class: 'ai-list' });
    this.input = h('textarea', { class: 'ai-input', rows: 3, placeholder: t('Tanya apa saja, atau minta bantuan di server…  (Enter kirim · Shift+Enter baris baru)') });
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
    });
    this.sendBtn = h('button', { class: 'btn primary ai-send', onclick: () => this.busy() ? this.stop() : this.send() }, t('Kirim'));
    this.agentChk = h('input', { type: 'checkbox' });
    this.agentChk.addEventListener('change', () => {
      store.settings.aiAgentMode = this.agentChk.checked;
      saveSettingsSoon();
      toast(this.agentChk.checked
        ? t('Mode Agen aktif: AI mengerjakan tugas langsung di layar dan tindakan disetujui otomatis (kecuali yang berbahaya).')
        : t('Mode Agen mati: AI kembali minta izin dan tidak menyentuh layar tanpa diminta.'), 'success');
      this.render();
    });
    const newBtn = h('button', { class: 'btn small', title: t('Mulai percakapan baru'), onclick: () => this.newChat() }, t('Chat baru'));
    const closeBtn = h('button', { class: 'icon-btn', title: t('Tutup panel AI (Ctrl+Shift+A)'), html: '&times;', onclick: () => this.toggle(false) });
    const resizer = h('div', { class: 'ai-resizer' });
    this.el = h('div', { class: 'ai-panel' },
      resizer,
      h('div', { class: 'ai-head' },
        h('span', { class: 'ai-title' }, 'AI'), this.providerSel, this.modelSel, h('span', { class: 'ai-spacer' }),
        h('button', { class: 'icon-btn', title: t('Kelola provider AI (OpenAI-compatible: URL + API key)'), html: '&#9881;', onclick: () => this.manageProviders() }),
        newBtn, closeBtn),
      this.target, this.installHint, this.usageEl, this.list,
      h('div', { class: 'ai-foot' },
        this.input,
        h('div', { class: 'ai-foot-row' },
          h('div', { class: 'ai-autos' },
            h('label', { class: 'ai-auto ai-agent', title: t('Mode Agen: AI mengerjakan tugas langsung di layar utama (mencari, membuka & mengedit file, menguji sampai bebas error, lalu melapor). Tindakan disetujui otomatis, kecuali yang berbahaya (hapus data, restart service, firewall, dll.).') }, this.agentChk, t('Mode Agen'))),
          this.sendBtn)));
    this.setupResize(resizer);
    this.applyVisibility();

    EventsOn('ai:tool', (ev: { reqId: string; chatId: string; name: string; args: any }) => this.onTool(ev));
    EventsOn('ai:toolCancel', (reqId: string) => this.onToolCancel(reqId));
    this.init();
  }

  /** Reloads providers after programs were installed or providers edited. */
  reloadProviders() { this.init(); }

  private async init() {
    this.providers = (await AIProviders()) as unknown as ProviderInfo[];
    invalidateCompanionProviders();
    const s = store.settings;
    s.aiModels = s.aiModels || {};
    const opt = (p: ProviderInfo) => h('option', { value: p.id, disabled: !p.installed }, p.name + (p.installed ? '' : t(' (tidak terpasang)')));
    const cli = this.providers.filter(p => p.kind !== 'openai');
    const api = this.providers.filter(p => p.kind === 'openai');
    this.providerSel.replaceChildren(...cli.map(opt),
      ...(api.length ? [h('optgroup', { label: 'OpenAI-compatible' }, ...api.map(opt))] : []));
    const usable = this.providers.find(p => p.id === s.aiProvider && p.installed) || this.providers.find(p => p.installed);
    if (usable) this.providerSel.value = usable.id;
    const missing = cli.filter(p => !p.installed);
    this.installHint.replaceChildren(...(missing.length ? [
      h('span', {}, t('{0} belum terpasang. ', missing.map(p => p.name).join(' & '))),
      h('button', { class: 'link', onclick: () => hooks.showSetup(missing[0].id) }, t('Pasang…'))] : []));
    this.installHint.classList.toggle('hidden', !missing.length);
    this.fillModels();
    this.render();
  }
  private installHint = h('div', { class: 'ai-install-hint hidden' });

  /** Dialog to add/edit/delete OpenAI-compatible providers (URL + API key). */
  private async manageProviders() {
    const listEl = h('div', { class: 'prov-list' });
    const refresh = async () => {
      const provs = await ListAIProviders();
      listEl.replaceChildren(...(provs.length ? provs.map(p => h('div', { class: 'prov-row' },
        h('div', { class: 'prov-text' }, h('b', {}, p.name), h('small', {}, p.baseUrl + (p.hasKey ? t(' · API key tersimpan') : t(' · tanpa API key')))),
        h('button', { class: 'btn small', onclick: async () => { if (await editProvider(p)) { await refresh(); } } }, 'Edit'),
        h('button', { class: 'btn small danger', onclick: async () => {
          if (await confirmDialog(t('Hapus provider'), t('Hapus "{0}"?', p.name), t('Hapus'), true)) { await DeleteAIProvider(p.id); await refresh(); }
        } }, t('Hapus')))) : [h('div', { class: 'muted' }, t('Belum ada provider tambahan.'))]));
    };
    await refresh();
    const body = h('div', { class: 'form' },
      h('div', { class: 'modal-text' }, t('Tambahkan layanan AI yang memakai API OpenAI (chat/completions): OpenAI, OpenRouter, Groq, DeepSeek, Together, Mistral, Ollama/LM Studio lokal, dll. Modelnya akan muncul di pilihan model panel AI.')),
      listEl,
      h('button', { class: 'btn', onclick: async () => { if (await editProvider(null)) await refresh(); } }, t('+ Tambah provider')));
    await openModal(t('Provider AI'), body, [{ label: t('Tutup'), value: 'close', primary: true }]);
    await this.init();
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
      h('option', { value: '__custom' }, t('Model lain…')));
    this.modelSel.value = chosen;
  }

  private onProviderChange() {
    store.settings.aiProvider = this.provider();
    saveSettingsSoon();
    this.fillModels();
    const c = this.chat();
    if (c && c.items.length && c.provider !== this.provider()) {
      this.note(c, t('Penyedia diganti ke {0}. Percakapan baru dimulai untuk penyedia ini.', this.providerName()));
    }
    this.render();
  }

  private async onModelChange() {
    let m = this.modelSel.value;
    if (m === '__custom') {
      const v = await promptText(t('Model lain'), t('Nama model untuk {0}', this.providerName()));
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
      c = { id: `c${++chatSeq}`, pane: p, work: p, terminals: [p], provider: this.provider(), items: [], busy: false, autoRead: false, autoWrite: false,
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
        if (st.error) this.note(c, t('AI berhenti: ') + st.error, true);
        if (st.stopped) this.note(c, t('Dihentikan.'));
        this.setBusy(c, false);
      }
    });
  }

  private busy() { return !!this.chat()?.busy; }

  private setBusy(c: Chat, busy: boolean) {
    c.busy = busy;
    c.pane.el.classList.toggle('ai-active', busy);
    if (!busy) this.paneStatus(c, '');
    else this.paneStatus(c, t('AI sedang bekerja…'));
    hooks.paneChanged(c.pane);
    if (c === this.chat()) this.render();
  }

  newChat() {
    const c = this.chat();
    if (!c) return;
    AIReset(c.id);
    this.forget(c);
    c.pane.el.classList.remove('ai-active');
    this.render();
    this.input.focus();
  }

  private forget(c: Chat) {
    for (const [k, v] of this.chats) if (v === c) this.chats.delete(k);
    this.byId.delete(c.id);
  }

  /** Forget the chat of a pane that is being closed. */
  disposePane(p: Pane) {
    const c = this.chats.get(p);
    if (!c) return;
    if (p !== c.pane) {
      // A terminal the AI opened: the chat goes on in the user's terminal.
      this.chats.delete(p);
      c.terminals = c.terminals.filter(t => t !== p);
      if (c.work === p) c.work = c.pane;
      return;
    }
    AIReset(c.id);
    this.forget(c);
  }

  private async send() {
    const text = this.input.value.trim();
    if (!text) return;
    const p = this.pane;
    if (!p) return;
    const c = this.chat(true)!;
    if (c.busy && this.provider() !== 'claude') { toast(t('AI masih bekerja; tunggu atau tekan Stop')); return; }
    if (c.provider !== this.provider()) { AIReset(c.id); c.provider = this.provider(); }
    this.input.value = '';
    c.items.push({ kind: 'user', text });
    this.setBusy(c, true);
    // Chat works without a server; the context just tells the AI what is available.
    const prof = p.profile;
    const context = prof
      ? `The user's terminal is an SSH session to server "${prof.name}" (${prof.user}@${prof.host}:${prof.port}).`
      : `The user's terminal is not connected to any server yet, so the tools are unavailable; just chat.`;
    let live = '';
    const w = c.work.connected ? c.work : p;
    if (w.connected) {
      try {
        const info = await Info(w.sessionId);
        const name = `T${c.terminals.indexOf(w) + 1 || 1}`;
        live = `[Working terminal ${name}: ${info.tmux ? `tmux session "${info.tmux}"` : 'plain shell'}, foreground program: ${info.cmd || '?'}, directory: ${info.cwd || '?'}` +
          (c.terminals.length > 1 ? `; terminals: ${c.terminals.map((t, i) => `T${i + 1}${t === c.work ? ' (working)' : ''}`).join(', ')}` : '') + ']\n';
      } catch { /* not critical */ }
    } else if (prof) {
      live = '[Terminal currently disconnected]\n';
    }
    if (store.settings.aiAgentMode && prof) live = '[AGENT MODE]\n' + live;
    try {
      await AISend(c.id, c.provider, store.settings.aiModels[c.provider] || this.modelSel.value || '', live + text, context);
    } catch (e) {
      this.note(c, t('Gagal mengirim: ') + String(e), true);
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
    if (c.provider === 'claude') this.onClaude(c, ev);
    else if (c.provider === 'codex') this.onCodex(c, ev);
    else this.onOpenAI(c, ev);
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

  private onOpenAI(c: Chat, ev: any) {
    switch (ev.type) {
      case 'oa.text': c.items.push({ kind: 'text', text: ev.text }); break;
      case 'oa.usage': {
        const u = ev.usage || {};
        const cached = u.prompt_tokens_details?.cached_tokens || 0;
        c.usage.input += Math.max(0, (u.prompt_tokens || 0) - cached);
        c.usage.cached += cached;
        c.usage.output += u.completion_tokens || 0;
        c.usage.turns++;
        break;
      }
      case 'oa.done': this.setBusy(c, false); break;
    }
  }

  private onCodex(c: Chat, ev: any) {
    switch (ev.type) {
      case 'item.completed': {
        const it = ev.item || {};
        if (it.type === 'agent_message' && it.text) c.items.push({ kind: 'text', text: it.text });
        else if (it.type === 'command_execution') this.note(c, t('Codex menjalankan perintah di komputer lokal (bukan server): {0}', it.command), true);
        else if (it.type === 'mcp_tool_call' && it.status === 'failed' && it.error?.message) this.note(c, t('Alat gagal: ') + it.error.message, true);
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
    if (!c) { reply(t('Chat tidak ditemukan'), true); return; }
    const args = typeof ev.args === 'string' ? JSON.parse(ev.args || '{}') : (ev.args || {});
    const item: Extract<Item, { kind: 'tool' }> = { kind: 'tool', reqId: ev.reqId, name: ev.name, args, status: 'running', output: '', open: false };
    c.items.push(item);
    if (!c.work.connected && c.work !== c.pane) c.work = c.pane;
    const p = c.work;
    if (!p.connected || !p.term) {
      item.status = 'error'; item.output = t('Terminal tidak terhubung');
      this.refresh(c);
      reply('The terminal is not connected to the server right now.', true);
      return;
    }
    const isRead = READ_TOOLS.has(ev.name);
    const agent = store.settings.aiAgentMode;
    const danger = agent ? dangerReason(ev.name, args) : '';
    if (danger || (!agent && (isRead ? !c.autoRead : !c.autoWrite))) {
      item.status = 'approval';
      this.refresh(c);
      if (!store.settings.aiVisible) this.toggle(true);
      const decision = await this.askApproval(c, item, danger);
      if ((item.status as ToolStatus) === 'cancelled') return; // CLI gave up meanwhile
      if (decision === false) {
        item.status = 'denied';
        this.refresh(c);
        reply('The user denied this action. Do not retry it; ask the user how to proceed.', true);
        return;
      }
      if (decision === 'all') {
        if (isRead) c.autoRead = true; else c.autoWrite = true;
        this.render();
      }
      item.status = 'running';
    }
    this.paneStatus(c, `AI: ${toolLabel(ev.name)}${ev.name === 'run_command' ? ' — ' + String(args.command).slice(0, 80) : ''}`);
    this.refresh(c);
    try {
      if (agent && ['read_screen', 'run_command', 'send_keys', 'wait_for_screen'].includes(ev.name)) hooks.revealPane(p);
      const out = await this.execTool(c, p, ev.name, args);
      item.status = 'done';
      item.output = out;
      reply(out || '(no output)');
    } catch (e) {
      item.status = 'error';
      item.output = String((e as any)?.message ?? e);
      reply(item.output, true);
    }
    this.paneStatus(c, c.busy ? t('AI sedang bekerja…') : '');
    this.refresh(c);
  }

  private refresh(c: Chat) { if (c === this.chat()) this.render(); }

  /** Approval shown both in the panel and on the terminal itself. */
  private askApproval(c: Chat, item: Extract<Item, { kind: 'tool' }>, danger = ''): Promise<boolean | 'all'> {
    return new Promise(resolve => {
      const bar = h('div', { class: 'ai-approve-bar' + (danger ? ' danger' : '') },
        h('div', { class: 'ai-approve-title' }, danger ? t('⚠ Tindakan berisiko ({0}). Izinkan?', danger) : t('AI meminta izin: {0}', toolLabel(item.name))),
        h('pre', { class: 'ai-approve-cmd' }, summarize(item.name, item.args, 600)),
        h('div', { class: 'ai-approve-btns' },
          h('button', { class: 'btn', onclick: () => done(false) }, t('Tolak')),
          danger ? null : h('button', { class: 'btn', onclick: () => done('all') }, READ_TOOLS.has(item.name) ? t('Izinkan semua baca') : t('Izinkan semua perubahan')),
          h('button', { class: 'btn primary' + (danger ? ' danger' : ''), onclick: () => done(true) }, t('Izinkan'))));
      if (danger) hooks.revealPane(c.work);
      c.work.el.append(bar);
      this.paneStatus(c, t('AI menunggu izin Anda'));
      const done = (v: boolean | 'all') => {
        this.approvals.delete(item.reqId);
        bar.remove();
        resolve(v);
      };
      this.approvals.set(item.reqId, done);
    });
  }

  private paneStatus(c: Chat, text: string) {
    for (const t of c.terminals) if (t !== c.work) t.el.querySelector('.ai-badge')?.remove();
    let badge = c.work.el.querySelector<HTMLElement>('.ai-badge');
    if (!text) { badge?.remove(); return; }
    if (!badge) { badge = h('div', { class: 'ai-badge' }); c.work.el.append(badge); }
    badge.textContent = text;
  }

  private termName(c: Chat, p: Pane) { return `T${c.terminals.indexOf(p) + 1}`; }

  private termList(c: Chat): string {
    return c.terminals.map((t, i) => `T${i + 1}${i === 0 ? ' (user\'s terminal)' : ' (opened by you)'}: ${t.title}${t.connected ? '' : ' — disconnected'}${t === c.work ? '  ← working terminal' : ''}`).join('\n');
  }

  /** Opens path in a visible editor tab and returns its code editor. */
  private async editorFor(c: Chat, path: string) {
    const pane = await hooks.openEditor(c.pane, path);
    const view = pane?.editor;
    if (!view) throw new Error(`Could not open ${path} in the editor (missing, binary, larger than 5 MB, or no permission).`);
    const ed = view.codeEditor?.();
    if (!ed) throw new Error(`${path} is not a text file; it cannot be edited in the editor.`);
    return ed;
  }

  private async execTool(c: Chat, p: Pane, name: string, a: any): Promise<string> {
    switch (name) {
      case 'open_terminal': {
        let dir = String(a.directory || '');
        if (!dir) { try { dir = (await Info(c.pane.sessionId)).cwd || ''; } catch { /* home */ } }
        const t = await hooks.openAITerminal(c.pane, dir);
        c.terminals.push(t);
        this.chats.set(t, c);
        c.work = t;
        this.render();
        await sleep(1200); // let the shell print its prompt
        return `Opened ${this.termName(c, t)} in a new tab; it is now your working terminal. Use use_terminal("T1") to go back to the user's terminal.\nTerminals:\n${this.termList(c)}\n\nScreen of ${this.termName(c, t)}:\n${await readScreen(t, 0)}`;
      }
      case 'use_terminal': {
        const n = Number(String(a.terminal || '').replace(/^T/i, ''));
        const t = c.terminals[n - 1];
        if (!t) throw new Error(`No terminal "${a.terminal}". Terminals:\n${this.termList(c)}`);
        if (!t.connected) throw new Error(`${a.terminal} is not connected.`);
        c.work = t;
        hooks.revealPane(t);
        this.render();
        return `Working terminal is now ${this.termName(c, t)}.\nTerminals:\n${this.termList(c)}\n\nScreen:\n${await readScreen(t, 0)}`;
      }
      case 'open_file': {
        const ed = await this.editorFor(c, String(a.path || ''));
        await ed.aiReload();
        return `Opened ${a.path} in an editor tab${ed.dirty ? ' (it has unsaved changes by the user)' : ''}. Content (line numbers are not part of the file):\n${ed.numbered()}`;
      }
      case 'edit_file': {
        const path = String(a.path || '');
        const edits = Array.isArray(a.edits) ? a.edits : [];
        if (!edits.length) throw new Error('edits is empty');
        const ed = await this.editorFor(c, path);
        if (ed.dirty) throw new Error(`The user has unsaved changes to ${path} in the editor; nothing was changed. Ask the user to save or discard them first.`);
        await ed.aiReload();
        const where = ed.aiApplyEdits(edits);
        await ed.aiSave();
        hooks.filesChanged();
        return `Edited and saved ${path}: changed ${where}. Now verify the change (syntax check / tests).`;
      }
      case 'read_screen': return readScreen(p, clamp(Number(a.history_lines) || 0, 0, 2000));
      case 'run_command': {
        // Typing a shell command into e.g. opencode or vim would do damage: refuse.
        const fg = await foreground(p);
        if (fg && !SHELLS.has(fg)) {
          throw new Error(`"${fg}" is running in the foreground of the terminal, not the shell prompt, so the command was NOT typed. ` +
            (store.settings.aiAgentMode
              ? `Do not disturb ${fg}: call open_terminal to get a new tab with a shell prompt and run it there (or hand the task to ${fg} with send_keys if it is an AI coding agent and the task is large).`
              : `Use run_background to run it without touching the user's screen. Only type into ${fg} if the user explicitly asked you to.`));
        }
        return runCommand(p, String(a.command || ''), clamp(Number(a.timeout_seconds) || 60, 5, 600));
      }
      case 'send_keys': {
        p.send(parseKeys(String(a.keys || ''), !!p.term?.modes.applicationCursorKeysMode));
        await sleep(clamp(Number(a.wait_ms) || 800, 100, 10000));
        return 'Keys sent. Screen now:\n' + await readScreen(p, 0);
      }
      case 'run_background':
        return RunHidden(p.sessionId, String(a.command || ''), clamp(Number(a.timeout_seconds) || 60, 5, 600));
      case 'wait_for_screen':
        return waitForScreen(p, String(a.until_text || ''), clamp(Number(a.seconds) || 30, 1, 300), clamp(Number(a.stable_ms) || 2000, 500, 30000));
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
        if (store.settings.aiAgentMode) {
          // Show the file the AI just wrote.
          try { await (await this.editorFor(c, String(a.path))).aiReload(); } catch { /* still written */ }
        }
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
      ? `Terminal: ${p.title} (${p.profile.user}@${p.profile.host})${p.connected ? '' : t(' — tidak terhubung')}`
      : t('Mode chat — terminal belum terhubung ke server.');
    if (c && c.work !== c.pane && c.work.connected) this.target.textContent += t(' · AI bekerja di {0} ({1})', `T${c.terminals.indexOf(c.work) + 1}`, c.work.title);
    this.agentChk.checked = !!store.settings.aiAgentMode;
    this.el.classList.toggle('agent-mode', !!store.settings.aiAgentMode);
    this.sendBtn.textContent = c?.busy ? 'Stop' : t('Kirim');
    this.sendBtn.classList.toggle('danger', !!c?.busy);
    this.renderUsage(c);

    const nodes: HTMLElement[] = [];
    if (!c || c.items.length === 0) {
      nodes.push(h('div', { class: 'ai-empty', html: t(`
        <b>Asisten AI</b><br>
        Tanyakan apa saja seperti chat biasa. Jika permintaan Anda butuh server, AI akan <b>meminta izin</b> dulu sebelum
        membaca layar/file, menjalankan perintah (terlihat langsung di terminal), menulis file, atau mengetik ke aplikasi
        yang sedang berjalan (misalnya opencode di tmux).<br><br>
        Contoh:<br>
        • <i>"jelaskan beda nginx dan apache"</i> (chat saja)<br>
        • <i>"kenapa service nginx di server ini gagal start?"</i><br>
        • <i>"jelaskan error yang ada di layar"</i><br>
        • <i>"minta opencode memperbaiki test yang gagal, lalu pantau hasilnya"</i><br><br>
        <b>Mode Agen</b> (centang di bawah): AI mengerjakan tugas sendiri langsung di layar sampai selesai —
        mencari & membuka file, mengedit (perubahan disorot di editor), menguji sampai bebas error, lalu melapor.
        Tindakan disetujui otomatis kecuali yang berisiko (hapus data, restart service, firewall…). Jika layar sedang
        dipakai program lain, AI membuka terminal baru di tab baru.<br>
        • <i>"ubah fungsi login di app.php supaya mencatat IP pengguna"</i>`) }));
    } else {
      for (const it of c.items) nodes.push(this.renderItem(it));
      if (c.busy) nodes.push(h('div', { class: 'ai-thinking' }, h('span', { class: 'ai-dots' }), t('AI sedang bekerja…')));
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
      const l5 = lim('five_hour', t('Limit 5 jam')), l7 = lim('seven_day', t('7 hari'));
      parts.push(l5 || l7 ? [l5, l7].filter(Boolean).join(' · ') : `<span class="muted">${t('Limit langganan muncul setelah pesan pertama')}</span>`);
    } else if (this.provider() === 'codex') {
      parts.push(`<span class="muted">${t('Codex tidak melaporkan sisa limit')}</span>`);
    } else {
      parts.push(`<span class="muted">${t('Provider API: biaya/limit dilihat di dashboard penyedia')}</span>`);
    }
    if (c && c.usage.turns) {
      const k = (n: number) => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
      let s = t('Chat ini: {0} masuk{1} · {2} keluar', k(c.usage.input), c.usage.cached ? ` (+${k(c.usage.cached)} cache)` : '', k(c.usage.output));
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
          approval: t('menunggu izin'), running: t('berjalan…'), done: t('selesai'), denied: t('ditolak'), error: t('gagal'), cancelled: t('dibatalkan'),
        };
        const head = h('div', { class: 'ai-tool-head' },
          h('span', { class: 'ai-tool-name' }, toolLabel(it.name)),
          h('span', { class: 'ai-tool-status ' + it.status }, statusText[it.status]));
        const box = h('div', { class: 'ai-tool ' + it.status }, head,
          h('pre', { class: 'ai-tool-args' }, summarize(it.name, it.args, 300)));
        if (it.status === 'approval') {
          const resolve = this.approvals.get(it.reqId);
          box.append(h('div', { class: 'ai-approve-btns' },
            h('button', { class: 'btn', onclick: () => resolve?.(false) }, t('Tolak')),
            h('button', { class: 'btn', onclick: () => resolve?.('all') }, READ_TOOLS.has(it.name) ? t('Izinkan semua baca') : t('Izinkan semua perubahan')),
            h('button', { class: 'btn primary', onclick: () => resolve?.(true) }, t('Izinkan'))));
        }
        if (it.output) {
          const out = h('pre', { class: 'ai-tool-out' + (it.open ? '' : ' collapsed') }, it.output.length > 20000 ? it.output.slice(-20000) : it.output);
          const toggle = h('button', { class: 'link' }, it.open ? t('Sembunyikan hasil') : t('Lihat hasil'));
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
    case 'run_command': case 'run_background': s = String(a.command ?? ''); break;
    case 'send_keys': s = String(a.keys ?? ''); break;
    case 'write_file': s = `${a.path}\n────\n${String(a.content ?? '')}`; break;
    case 'read_file': case 'list_dir': s = String(a.path ?? ''); break;
    case 'read_screen': s = a.history_lines ? t('layar + {0} baris riwayat', a.history_lines) : t('layar saat ini'); break;
    case 'wait_for_screen': s = a.until_text ? t('tunggu sampai muncul "{0}" (maks {1} dtk)', a.until_text, a.seconds || 30) : t('tunggu layar berhenti berubah (maks {0} dtk)', a.seconds || 30); break;
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
  const fg = await foreground(p);
  return (fg ? `[foreground program: ${fg}]\n` : '') + lines.join('\n') +
    `\n[cursor at row ${buf.cursorY + 1}, col ${buf.cursorX + 1}; ${term.cols}x${term.rows}]`;
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
  enter: '\r', return: '\r', cr: '\r', tab: '\t', esc: '\x1b', escape: '\x1b', backspace: '\x7f', bs: '\x7f', space: ' ',
  home: '\x1b[H', end: '\x1b[F', pageup: '\x1b[5~', pagedown: '\x1b[6~', pgup: '\x1b[5~', pgdn: '\x1b[6~',
  delete: '\x1b[3~', del: '\x1b[3~', insert: '\x1b[2~', 's-tab': '\x1b[Z', 'shift-tab': '\x1b[Z', backtab: '\x1b[Z',
  f1: '\x1bOP', f2: '\x1bOQ', f3: '\x1bOR', f4: '\x1bOS', f5: '\x1b[15~', f6: '\x1b[17~', f7: '\x1b[18~',
  f8: '\x1b[19~', f9: '\x1b[20~', f10: '\x1b[21~', f11: '\x1b[23~', f12: '\x1b[24~',
  'c-space': '\x00', 'ctrl-space': '\x00',
};
const ARROWS: Record<string, string> = { up: 'A', down: 'B', right: 'C', left: 'D' };

/**
 * Converts "text<Enter><C-c><M-x><F5>" into terminal bytes. appCursor follows the
 * terminal's cursor-key mode (TUIs such as vim/opencode switch it on).
 */
export function parseKeys(s: string, appCursor = false): string {
  return s.replace(/<([^<>\s][^<>]*)>/g, (whole, name: string) => {
    const k = name.trim().toLowerCase();
    if (ARROWS[k]) return (appCursor ? '\x1bO' : '\x1b[') + ARROWS[k];
    if (KEYMAP[k] !== undefined) return KEYMAP[k];
    const ctrl = /^(?:ctrl|c)-([a-z@\[\\\]^_])$/.exec(k);
    if (ctrl) return String.fromCharCode(ctrl[1].toUpperCase().charCodeAt(0) & 0x1f);
    const alt = /^(?:alt|m|meta)-(.)$/i.exec(name.trim());
    if (alt) return '\x1b' + alt[1];
    return whole;
  });
}

/** Program in the foreground of the terminal ("bash" when idle), or '' if unknown. */
async function foreground(p: Pane): Promise<string> {
  try { return (await Info(p.sessionId)).cmd || ''; } catch { return ''; }
}

function screenSnapshot(p: Pane): string {
  const term = p.term!;
  const buf = term.buffer.active;
  return bufferLines(p, buf.viewportY, buf.viewportY + term.rows).join('\n');
}

/** Waits until text appears or the screen stops changing, then returns it. */
async function waitForScreen(p: Pane, until: string, seconds: number, stableMs: number): Promise<string> {
  const deadline = Date.now() + seconds * 1000;
  let last = '', lastChange = Date.now();
  while (Date.now() < deadline) {
    if (!p.term) throw new Error('terminal closed');
    const snap = screenSnapshot(p);
    if (until && snap.includes(until)) return `Found "${until}". Screen:\n` + await readScreen(p, 0);
    if (snap !== last) { last = snap; lastChange = Date.now(); }
    else if (!until && Date.now() - lastChange >= stableMs) return 'Screen is stable. Screen:\n' + await readScreen(p, 0);
    await sleep(300);
  }
  return `Waited ${seconds}s${until ? ` but "${until}" did not appear` : ' (screen kept changing)'}. Screen:\n` + await readScreen(p, 0);
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

/** Form for one OpenAI-compatible provider. Resolves true when saved. */
async function editProvider(p: { id: string; name: string; baseUrl: string; hasKey: boolean; models: string[] } | null): Promise<boolean> {
  const name = h('input', { type: 'text', value: p?.name ?? '', placeholder: t('contoh: OpenRouter') });
  const url = h('input', { type: 'text', value: p?.baseUrl ?? '', placeholder: 'https://openrouter.ai/api/v1', spellcheck: 'false' });
  const key = h('input', { type: 'password', placeholder: p?.hasKey ? t('(tersimpan — kosongkan agar tidak berubah)') : t('sk-…  (kosongkan untuk server lokal tanpa key)') });
  const models = h('input', { type: 'text', value: (p?.models ?? []).join(', '), placeholder: t('kosong = ambil otomatis dari /models'), spellcheck: 'false' });
  const info = h('div', { class: 'form-hint' });
  const err = h('div', { class: 'form-error' });
  const input = () => main.AIProviderInput.createFrom({
    id: p?.id ?? '', name: name.value, baseUrl: url.value, apiKey: key.value,
    keepKey: !!p?.hasKey && key.value === '', models: models.value,
  });
  const test = h('button', { class: 'btn small', onclick: async () => {
    info.textContent = t('Menguji…'); err.textContent = '';
    try {
      const list = await TestAIProvider(input());
      info.textContent = t('Berhasil: {0} model ditemukan{1}.', list.length, list.length ? t(' (mis. {0})', list.slice(0, 4).join(', ')) : '');
    } catch (e) { info.textContent = ''; err.textContent = t('Gagal: ') + errMsg(e); }
  } }, t('Tes koneksi'));
  const body = h('div', { class: 'form' },
    h('label', {}, t('Nama'), name),
    h('label', {}, 'Base URL (OpenAI-compatible)', url,
      h('small', {}, t('Contoh: https://api.openai.com/v1 · https://openrouter.ai/api/v1 · https://api.groq.com/openai/v1 · http://localhost:11434/v1 (Ollama)'))),
    h('label', {}, t('API key (disimpan terenkripsi)'), key),
    h('label', {}, t('Model (opsional, pisahkan dengan koma)'), models),
    h('div', { class: 'input-row' }, test, info),
    err);
  const r = await openModal(p ? t('Edit provider') : t('Tambah provider'), body,
    [{ label: t('Batal'), value: 'cancel' }, { label: t('Simpan'), value: 'ok', primary: true }],
    async v => {
      if (v !== 'ok') return true;
      try { await SaveAIProvider(input()); return true; } catch (e) { err.textContent = errMsg(e); return false; }
    });
  if (r === 'ok') toast(t('Provider AI disimpan'), 'success');
  return r === 'ok';
}
