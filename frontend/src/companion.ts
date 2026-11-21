// AI Companion: Copilot-style grey inline suggestions in the code editor.
// Off by default; the "AI Companion" button in the top bar turns it on and off.
// To save tokens the AI is only asked when the user presses Alt+\; Tab accepts
// the suggestion, Esc dismisses it.
import { t } from './i18n';
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
  // Antigravity runs as an agent (ACP) only, not for one-shot suggestions.
  if (!providers || force) providers = ((await AIProviders()) as unknown as ProviderInfo[]).filter(p => p.id !== 'antigravity');
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
    toast(t('AI Companion dimatikan'));
    return;
  }
  let r = await resolve().catch(() => null);
  if (!r) {
    toast(t('Belum ada AI yang terhubung. Pasang Claude Code / Codex atau tambahkan provider di panel AI (⚙).'), 'error');
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
  toast(t('AI Companion aktif ({0}). Tekan Alt+\\ di editor untuk meminta saran.', r.p.name + (r.model ? ' · ' + r.model : '')), 'success');
}

/** Dialog to choose the provider and model. Resolves true when saved. */
export async function companionSettings(): Promise<boolean> {
  const list = await loadProviders(true);
  const cur = await resolve();
  const provSel = h('select', {}, ...list.map(p =>
    h('option', { value: p.id, disabled: !p.installed }, p.name + (p.installed ? '' : t(' (tidak terpasang)')))));
  if (cur) provSel.value = cur.p.id;
  const modelInput = h('input', { type: 'text', spellcheck: 'false', list: 'companion-models', value: cur?.model ?? '' });
  const dl = h('datalist', { id: 'companion-models' });
  const hint = h('div', { class: 'muted companion-hint' });
  const fill = (keepModel: boolean) => {
    const p = list.find(x => x.id === provSel.value);
    dl.replaceChildren(...(p?.models ?? []).filter(Boolean).map(m => h('option', { value: m })));
    if (!keepModel) modelInput.value = p?.id === 'claude' ? 'haiku' : p?.defaultModel ?? '';
    hint.textContent = p?.kind === 'openai'
      ? t('API (OpenAI-compatible): paling cepat. Model kecil/cepat sudah cukup untuk saran kode.')
      : t('CLI: saran butuh beberapa detik dan memakai kuota langganan Anda. Model kecil (mis. haiku) disarankan.');
  };
  provSel.addEventListener('change', () => fill(false));
  fill(true);
  const body = h('div', { class: 'form' },
    h('label', {}, t('Provider AI'), provSel),
    h('label', {}, 'Model', modelInput, dl),
    hint,
    h('div', { class: 'muted companion-hint' }, t('Saran hanya diminta saat Anda menekan Alt+\\. Yang dikirim: kode di sekitar kursor (sekitar 4.000 karakter) dan ringkasan import serta nama fungsi/kelas dari bagian file lainnya.')));
  const r = await openModal('AI Companion', body, [
    { label: t('Batal'), value: 'cancel' },
    { label: t('Simpan'), value: 'save', primary: true },
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

/** The last suggestion, so it stays visible while the user types it out. */
let last: { uri: string; start: number; before: string; insert: string } | null = null;

let registered = false;

/** Registers the inline-suggestion provider with Monaco (once). */
export function registerCompanion(monaco: typeof Monaco) {
  if (registered) return;
  registered = true;
  monaco.languages.registerInlineCompletionsProvider({ pattern: '**' }, {
    async provideInlineCompletions(model, position, context, token) {
      if (!companion.enabled) return { items: [] };
      const here = new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);
      const offset = model.getOffsetAt(position);
      const text = model.getValue();
      const manual = context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit;
      if (!manual) {
        // Only Alt+\ asks the AI (no tokens spent while typing). Monaco calls
        // this on every edit, so just keep the last suggestion alive while the
        // user types the same characters it suggested.
        const l = last;
        if (l && l.uri === model.uri.toString() && offset >= l.start &&
          text.slice(Math.max(0, l.start - 200), l.start) === l.before) {
          const typed = text.slice(l.start, offset);
          if (l.insert.startsWith(typed) && typed.length < l.insert.length) {
            return { items: [{ insertText: l.insert.slice(typed.length), range: here }] };
          }
        }
        last = null;
        return { items: [] };
      }
      const r = await resolve().catch(() => null);
      if (!r) {
        toast(t('AI Companion: belum ada AI yang terhubung'), 'error');
        return { items: [] };
      }
      const id = `c${++reqSeq}`;
      const sub = token.onCancellationRequested(() => AICancelComplete(id));
      setStatus('thinking');
      try {
        const insert = await AIComplete(main.CompletionRequest.createFrom({
          id, provider: r.p.id, model: r.model, path: model.uri.path, language: model.getLanguageId(),
          prefix: text.slice(0, offset), suffix: text.slice(offset),
        }));
        if (companion.enabled) setStatus('idle');
        if (token.isCancellationRequested) return { items: [] };
        if (!insert) {
          toast(t('AI Companion: tidak ada saran untuk posisi ini'));
          return { items: [] };
        }
        last = { uri: model.uri.toString(), start: offset, before: text.slice(Math.max(0, offset - 200), offset), insert };
        return { items: [{ insertText: insert, range: here }] };
      } catch (e) {
        setStatus('error', errMsg(e));
        toast('AI Companion: ' + errMsg(e), 'error');
        return { items: [] };
      } finally {
        sub.dispose();
      }
    },
    freeInlineCompletions() {},
  });
}
