// AI Companion: Copilot-style grey inline suggestions in the code editor.
// Off by default; the "Companion" button in the top bar turns it on and off.
// Tab accepts a suggestion, Esc dismisses it, Alt+\ asks for one right away.
import type * as Monaco from 'monaco-editor';
import { AICancelComplete, AIComplete, AIProviders } from '../wailsjs/go/main/App';
import { main } from '../wailsjs/go/models';
import { saveSettingsSoon, store } from './state';
import { errMsg, h, openModal, toast } from './ui';

export interface ProviderInfo { id: string; name: string; installed: boolean; models: string[]; defaultModel: string; kind: string }
export type CompanionStatus = 'off' | 'idle' | 'thinking' | 'error';

let providers: ProviderInfo[] | null = null;
let status: CompanionStatus = 'idle';
let lastError = '';
const listeners = new Set<() => void>();
let reqSeq = 0;

export const companion = {
  get enabled() { return !!store.settings.companion; },
  get status(): CompanionStatus { return store.settings.companion ? status : 'off'; },
  get error() { return lastError; },
  onChange(f: () => void) { listeners.add(f); return () => listeners.delete(f); },
};

function setStatus(s: CompanionStatus, err = '') {
  status = s; lastError = err;
  listeners.forEach(f => f());
}

async function loadProviders(force = false): Promise<ProviderInfo[]> {
  if (!providers || force) providers = (await AIProviders()) as unknown as ProviderInfo[];
  return providers;
}

/** The provider and model suggestions are requested from. */
async function resolve(): Promise<{ p: ProviderInfo; model: string } | null> {
  const list = (await loadProviders()).filter(p => p.installed);
  const s = store.settings;
  const p = list.find(x => x.id === s.companionProvider) || list.find(x => x.kind === 'openai')
    || list.find(x => x.id === 'claude') || list[0];
  if (!p) return null;
  const model = (p.id === s.companionProvider && s.companionModel) || (p.id === 'claude' ? 'haiku' : p.defaultModel || '');
  return { p, model };
}

/** Turns the companion on or off (asks for a provider when none is usable). */
export async function toggleCompanion() {
  if (companion.enabled) {
    store.settings.companion = false;
    saveSettingsSoon();
    setStatus('off');
    toast('AI Companion dimatikan');
    return;
  }
  let r = await resolve().catch(() => null);
  if (!r) {
    toast('Belum ada AI yang terhubung. Pasang Claude Code / Codex atau tambahkan provider di panel AI (⚙).', 'error');
    return;
  }
  if (!store.settings.companionProvider) {
    if (!(await companionSettings())) return;
    r = await resolve();
    if (!r) return;
  }
  store.settings.companion = true;
  saveSettingsSoon();
  setStatus('idle');
  toast(`AI Companion aktif: ${r.p.name}${r.model ? ' · ' + r.model : ''}`, 'success');
}

/** Dialog to choose the provider and model. Resolves true when saved. */
export async function companionSettings(): Promise<boolean> {
  const list = await loadProviders(true);
  const cur = await resolve();
  const provSel = h('select', {}, ...list.map(p =>
    h('option', { value: p.id, disabled: !p.installed }, p.name + (p.installed ? '' : ' (tidak terpasang)'))));
  if (cur) provSel.value = cur.p.id;
  const modelInput = h('input', { type: 'text', spellcheck: 'false', list: 'companion-models', value: cur?.model ?? '' });
  const dl = h('datalist', { id: 'companion-models' });
  const hint = h('div', { class: 'muted companion-hint' });
  const fill = (keepModel: boolean) => {
    const p = list.find(x => x.id === provSel.value);
    dl.replaceChildren(...(p?.models ?? []).filter(Boolean).map(m => h('option', { value: m })));
    if (!keepModel) modelInput.value = p?.id === 'claude' ? 'haiku' : p?.defaultModel ?? '';
    hint.textContent = p?.kind === 'openai'
      ? 'API (OpenAI-compatible): paling cepat. Pilih model kecil/cepat untuk saran yang responsif.'
      : 'CLI: saran muncul lebih lambat (beberapa detik) dan memakai kuota langganan Anda. Model kecil (mis. haiku) disarankan.';
  };
  provSel.addEventListener('change', () => fill(false));
  fill(true);
  const body = h('div', { class: 'form' },
    h('label', {}, 'Provider AI', provSel),
    h('label', {}, 'Model', modelInput, dl),
    hint,
    h('div', { class: 'muted companion-hint' }, 'Potongan kode di sekitar kursor dikirim ke provider ini setiap kali saran diminta.'));
  const r = await openModal('AI Companion', body, [
    { label: 'Batal', value: 'cancel' },
    { label: 'Simpan', value: 'save', primary: true },
  ]);
  if (r !== 'save') return false;
  store.settings.companionProvider = provSel.value;
  store.settings.companionModel = modelInput.value.trim();
  saveSettingsSoon();
  listeners.forEach(f => f());
  return true;
}

/** Reloads providers after the AI panel's provider list changed. */
export function invalidateCompanionProviders() { providers = null; }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let registered = false;

/** Registers the inline-suggestion provider with Monaco (once). */
export function registerCompanion(monaco: typeof Monaco) {
  if (registered) return;
  registered = true;
  monaco.languages.registerInlineCompletionsProvider({ pattern: '**' }, {
    async provideInlineCompletions(model, position, context, token) {
      if (!companion.enabled) return { items: [] };
      const r = await resolve().catch(() => null);
      if (!r) return { items: [] };
      const manual = context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit;
      if (!manual) {
        // Wait for a pause in typing; CLIs are slow, so wait longer for them.
        await sleep(r.p.kind === 'openai' ? 450 : 1100);
        if (token.isCancellationRequested) return { items: [] };
        // Don't suggest in the middle of a word.
        const after = model.getLineContent(position.lineNumber).slice(position.column - 1);
        if (/^\w/.test(after)) return { items: [] };
      }
      const offset = model.getOffsetAt(position);
      const text = model.getValue();
      const id = `c${++reqSeq}`;
      const sub = token.onCancellationRequested(() => AICancelComplete(id));
      setStatus('thinking');
      try {
        const insert = await AIComplete(main.CompletionRequest.createFrom({
          id, provider: r.p.id, model: r.model, path: model.uri.path, language: model.getLanguageId(),
          prefix: text.slice(0, offset), suffix: text.slice(offset),
        }));
        if (companion.enabled) setStatus('idle');
        if (token.isCancellationRequested || !insert) return { items: [] };
        return { items: [{ insertText: insert, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] };
      } catch (e) {
        setStatus('error', errMsg(e));
        if (manual) toast('AI Companion: ' + errMsg(e), 'error');
        return { items: [] };
      } finally {
        sub.dispose();
      }
    },
    freeInlineCompletions() {},
  });
}
