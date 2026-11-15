// A remote file opened in the built-in editor (Monaco, like VS Code).
import { OpenFileForEdit, SaveEditedFile } from '../wailsjs/go/main/App';
import { companion, companionSettings, toggleCompanion } from './companion';
import { saveSettingsSoon, store } from './state';
import { errMsg, h, openModal, toast } from './ui';

type MonacoMod = typeof import('./monaco');

let monacoMod: Promise<MonacoMod> | null = null;
const loadMonaco = () => (monacoMod ??= import('./monaco'));

export class EditorView {
  el: HTMLElement;
  private host: HTMLElement;
  private status: HTMLElement;
  private crumb: HTMLElement;
  private ed: import('monaco-editor').editor.IStandaloneCodeEditor | null = null;
  private stamp = '';
  private savedVersion = 0;
  private saving = false;
  language = 'plaintext';
  private mod: MonacoMod | null = null;
  private offCompanion: (() => void) | null = null;

  constructor(public sessionId: string, public path: string, private onChange: () => void) {
    this.crumb = h('div', { class: 'ed-crumb', title: path });
    this.host = h('div', { class: 'ed-host' }, h('div', { class: 'ed-loading' }, 'Membuka ' + path + ' …'));
    this.status = h('div', { class: 'ed-status' });
    this.el = h('div', { class: 'editor-view' }, this.crumb, this.host, this.status);
    this.renderCrumb();
  }

  get fileName() { return this.path.split('/').pop() || this.path; }

  get dirty(): boolean {
    const m = this.ed?.getModel();
    return !!m && m.getAlternativeVersionId() !== this.savedVersion;
  }

  /** Loads the file; throws with a readable message on failure. */
  async load() {
    const [mod, file] = await Promise.all([loadMonaco(), OpenFileForEdit(this.sessionId, this.path)]);
    const { monaco, languageFor, languageName } = mod;
    this.mod = mod;
    this.stamp = file.stamp;
    this.language = languageFor(this.fileName);
    const uri = monaco.Uri.parse(`remote://${this.sessionId}${this.path.split('/').map(encodeURIComponent).join('/')}`);
    monaco.editor.getModel(uri)?.dispose();
    const model = monaco.editor.createModel(file.content, this.language, uri);
    this.host.replaceChildren();
    this.ed = monaco.editor.create(this.host, {
      model,
      theme: 'vs-dark',
      automaticLayout: true,
      fontFamily: store.settings.fontFamily,
      fontSize: store.settings.fontSize,
      lineNumbers: 'on',
      minimap: { enabled: false },
      wordWrap: store.settings.editorWordWrap ? 'on' : 'off',
      wordBasedSuggestions: 'currentDocument',
      quickSuggestions: { other: true, comments: false, strings: false },
      suggestOnTriggerCharacters: true,
      tabCompletion: 'on',
      snippetSuggestions: 'top',
      parameterHints: { enabled: true },
      folding: true,
      showFoldingControls: 'mouseover',
      guides: { indentation: true, bracketPairs: 'active' },
      stickyScroll: { enabled: true },
      linkedEditing: true,
      autoClosingBrackets: 'languageDefined',
      autoClosingQuotes: 'languageDefined',
      autoIndent: 'full',
      matchBrackets: 'always',
      inlineSuggest: { enabled: true, showToolbar: 'onHover' },
      renderWhitespace: 'selection',
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      mouseWheelZoom: false,
      tabSize: store.settings.editorTabSize || 4,
      detectIndentation: true,
      bracketPairColorization: { enabled: true },
      unicodeHighlight: { ambiguousCharacters: false },
    });
    this.savedVersion = model.getAlternativeVersionId();
    this.ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { this.save(); });
    // VS Code shortcuts that the standalone Monaco editor doesn't define itself.
    this.ed.addAction({ id: 'rt.toggleWordWrap', label: 'View: Toggle Word Wrap', keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ], run: () => this.toggleWrap() });
    this.ed.addAction({ id: 'rt.changeLanguage', label: 'Change Language Mode', keybindings: [monaco.KeyMod.chord(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, monaco.KeyCode.KeyM)], run: () => { this.pickLanguage(); } });
    this.ed.addAction({ id: 'rt.companionTrigger', label: 'AI Companion: Minta Saran', keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.Backslash], run: ed => {
      if (!companion.enabled) { toast('AI Companion belum aktif. Aktifkan lewat tombol AI Companion di bagian atas.'); return; }
      ed.trigger('companion', 'editor.action.inlineSuggest.trigger', {});
    } });
    this.ed.addAction({ id: 'rt.companionToggle', label: 'AI Companion: Aktifkan / Matikan', run: () => { toggleCompanion(); } });
    this.ed.addAction({ id: 'rt.companionSettings', label: 'AI Companion: Pilih Provider & Model', run: () => { companionSettings(); } });
    this.offCompanion = companion.onChange(() => this.renderStatus());
    this.ed.addAction({ id: 'rt.save', label: 'File: Save', run: () => { this.save(); } });
    model.onDidChangeContent(() => { this.renderCrumb(); this.renderStatus(); this.onChange(); });
    this.ed.onDidChangeCursorSelection(() => this.renderStatus());
    this.renderStatus(languageName(this.language));
    this.renderCrumb();
    this.ed.focus();
  }

  private renderCrumb() {
    const parts = this.path.split('/').filter(Boolean);
    this.crumb.replaceChildren(
      h('span', { class: 'ed-path' }, '/' + parts.slice(0, -1).join('/') + (parts.length > 1 ? '/' : '')),
      h('span', { class: 'ed-file' }, this.fileName),
      ...(this.dirty ? [h('span', { class: 'ed-dirty', title: 'Belum disimpan' }, '●')] : []),
      h('span', { class: 'ed-spacer' }),
      h('button', { class: 'btn small ghost', title: 'Palet perintah (F1)', onclick: () => this.runAction('editor.action.quickCommand') }, 'Perintah'),
      h('button', { class: 'btn small ghost', title: 'Format dokumen (Shift+Alt+F)', onclick: () => this.format() }, 'Format'),
      h('button', { class: 'btn small ghost' + (store.settings.editorWordWrap ? ' on' : ''), title: 'Bungkus baris panjang (Alt+Z)', onclick: () => this.toggleWrap() }, 'Wrap'),
      h('button', { class: 'btn small' + (this.dirty ? ' primary' : ''), title: 'Simpan (Ctrl+S)', onclick: () => this.save() }, 'Simpan'));
  }

  private langLabel = '';
  private renderStatus(lang?: string) {
    if (lang) this.langLabel = lang;
    const m = this.ed?.getModel();
    const pos = this.ed?.getPosition();
    if (!m || !pos) return;
    const opts = m.getOptions();
    const eol = m.getEOL() === '\r\n' ? 'CRLF' : 'LF';
    const sel = this.ed!.getSelection();
    const selLen = sel && !sel.isEmpty() ? m.getValueLengthInRange(sel) : 0;
    this.status.replaceChildren(
      h('span', {}, `Ln ${pos.lineNumber}, Col ${pos.column}` + (selLen ? ` (${selLen} dipilih)` : '')),
      h('span', { class: 'ed-spacer' }),
      ...(this.dirty ? [h('span', {}, 'belum disimpan')] : []),
      h('span', {}, opts.insertSpaces ? 'Spasi: ' + opts.tabSize : 'Tab: ' + opts.tabSize),
      h('span', {}, 'UTF-8'),
      h('span', {}, eol),
      this.companionBadge(),
      h('button', { class: 'ed-st-btn', title: 'Ganti bahasa (Ctrl+K M)', onclick: () => this.pickLanguage() }, this.langLabel));
  }

  private companionBadge(): HTMLElement {
    const st = companion.status;
    const label = st === 'off' ? 'AI Companion: mati' : st === 'thinking' ? 'AI Companion: berpikir…' : st === 'error' ? 'AI Companion: galat' : 'AI Companion: Alt+\\';
    const title = st === 'error' ? companion.error + '\nKlik untuk mengatur provider.' : 'AI Companion: Tab terima saran, Esc tolak, Alt+\\ minta saran. Klik untuk mengatur provider.';
    return h('button', { class: 'ed-st-btn companion-' + st, title, onclick: () => companionSettings() }, label);
  }

  private runAction(id: string) {
    this.ed?.focus();
    this.ed?.getAction(id)?.run();
  }

  /** Formats the document (Monaco has formatters for JSON, HTML, CSS, JS and TS). */
  private async format() {
    const a = this.ed?.getAction('editor.action.formatDocument');
    if (!a || !a.isSupported()) {
      toast(`Format otomatis belum tersedia untuk ${this.langLabel}`, 'info');
      return;
    }
    await a.run();
    this.ed?.focus();
  }

  private toggleWrap() {
    store.settings.editorWordWrap = !store.settings.editorWordWrap;
    saveSettingsSoon();
    this.ed?.updateOptions({ wordWrap: store.settings.editorWordWrap ? 'on' : 'off' });
    this.renderCrumb();
  }

  /** Lets the user change the language used for highlighting and completion. */
  private async pickLanguage() {
    const mod = this.mod, m = this.ed?.getModel();
    if (!mod || !m) return;
    const list = mod.languageList();
    const filter = h('input', { class: 'lang-filter', type: 'text', placeholder: 'Cari bahasa…', spellcheck: 'false' });
    const box = h('div', { class: 'lang-list' });
    const close = () => filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const choose = (id: string) => {
      mod.monaco.editor.setModelLanguage(m, id);
      this.language = id;
      this.renderStatus(mod.languageName(id));
      close();
    };
    const render = () => {
      const q = filter.value.trim().toLowerCase();
      box.replaceChildren(...list.filter(l => !q || l.name.toLowerCase().includes(q) || l.id.includes(q)).map(l =>
        h('button', { class: 'lang-item' + (l.id === this.language ? ' on' : ''), onclick: () => choose(l.id) },
          h('span', {}, l.name), h('small', {}, l.id))));
    };
    filter.addEventListener('input', render);
    filter.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); box.querySelector<HTMLButtonElement>('button')?.click(); }
    });
    render();
    await openModal('Pilih bahasa', h('div', {}, filter, box), [{ label: 'Tutup', value: 'close' }]);
    this.ed?.focus();
  }

  /** Saves to the server. Resolves true when the file is saved. */
  async save(force = false): Promise<boolean> {
    const m = this.ed?.getModel();
    if (!m || this.saving) return false;
    this.saving = true;
    const version = m.getAlternativeVersionId();
    try {
      this.stamp = await SaveEditedFile(this.sessionId, this.path, m.getValue(), this.stamp, force);
      this.savedVersion = version;
      toast(`Tersimpan: ${this.fileName}`, 'success');
      this.renderCrumb(); this.renderStatus(); this.onChange();
      return true;
    } catch (e) {
      const msg = String(e);
      if (msg.startsWith('conflict:')) {
        this.saving = false;
        const body = h('div', { class: 'modal-text' });
        body.textContent = msg.slice('conflict:'.length) + '. Menyimpan sekarang akan menimpa perubahan tersebut.';
        const r = await openModal('File berubah di server', body, [
          { label: 'Batal', value: 'cancel' },
          { label: 'Timpa', value: 'overwrite', danger: true, primary: true },
        ]);
        return r === 'overwrite' ? this.save(true) : false;
      }
      toast(`Gagal menyimpan ${this.fileName}: ${errMsg(e)}`, 'error');
      return false;
    } finally {
      this.saving = false;
    }
  }

  // ---------- used by the AI agent (visible editing) ----------

  /** Itself; Markdown and other views return their inner code editor. */
  codeEditor(): EditorView { return this; }

  /** Reloads the file from the server unless the user has unsaved changes. */
  async aiReload() {
    const m = this.ed?.getModel();
    if (!m || this.dirty) return;
    const file = await OpenFileForEdit(this.sessionId, this.path);
    this.stamp = file.stamp;
    if (m.getValue() !== file.content) {
      m.setValue(file.content);
    }
    this.savedVersion = m.getAlternativeVersionId();
    this.renderCrumb(); this.renderStatus(); this.onChange();
  }

  /** The content with line numbers, as the AI sees it. */
  numbered(maxBytes = 200000): string {
    const m = this.ed?.getModel();
    if (!m) return '';
    const lines = m.getLinesContent();
    const w = String(lines.length).length;
    let out = '', i = 0;
    for (; i < lines.length && out.length < maxBytes; i++) out += `${String(i + 1).padStart(w)}| ${lines[i]}\n`;
    if (i < lines.length) out += `… (${lines.length - i} more lines not shown)\n`;
    return out;
  }

  /** Applies exact-text replacements visibly (undoable with Ctrl+Z), highlights
   *  them and returns a summary. Throws when a text is missing or ambiguous. */
  aiApplyEdits(edits: { old_text: string; new_text: string }[]): string {
    const m = this.ed?.getModel();
    const mod = this.mod;
    if (!m || !mod || !this.ed) throw new Error('editor not ready');
    const eol = m.getEOL();
    const norm = (s: string) => s.replace(/\r\n/g, '\n').replace(/\n/g, eol);
    const text = m.getValue();
    const ops: { range: import('monaco-editor').Range; text: string; old: string }[] = [];
    edits.forEach((e, n) => {
      const oldT = norm(String(e.old_text ?? ''));
      const newT = norm(String(e.new_text ?? ''));
      if (!oldT) throw new Error(`edit ${n + 1}: old_text is empty (use write_file to create a file, or include surrounding text to insert)`);
      const at = text.indexOf(oldT);
      if (at < 0) throw new Error(`edit ${n + 1}: old_text was not found in ${this.path}. Nothing was changed. Use open_file to see the exact current text (including indentation) and try again.`);
      if (text.indexOf(oldT, at + 1) >= 0) throw new Error(`edit ${n + 1}: old_text occurs more than once in ${this.path}. Nothing was changed. Include more surrounding lines so it is unique.`);
      const s = m.getPositionAt(at), en = m.getPositionAt(at + oldT.length);
      ops.push({ range: new mod.monaco.Range(s.lineNumber, s.column, en.lineNumber, en.column), text: newT, old: oldT });
    });
    for (let i = 0; i < ops.length; i++) for (let j = i + 1; j < ops.length; j++) {
      if (mod.monaco.Range.areIntersectingOrTouching(ops[i].range, ops[j].range)) throw new Error(`edits ${i + 1} and ${j + 1} overlap; merge them into one edit. Nothing was changed.`);
    }
    this.ed.pushUndoStop();
    this.ed.executeEdits('ai', ops.map(o => ({ range: o.range, text: o.text, forceMoveMarkers: true })));
    this.ed.pushUndoStop();
    // Highlight what changed: compute the new ranges from the end positions.
    const changed: { start: number; end: number }[] = [];
    let shift = 0;
    for (const o of [...ops].sort((a, b) => a.range.startLineNumber - b.range.startLineNumber)) {
      const start = o.range.startLineNumber + shift;
      const newLines = o.text.split(eol).length;
      changed.push({ start, end: start + newLines - 1 });
      shift += newLines - o.old.split(eol).length;
    }
    const deco = this.ed.createDecorationsCollection(changed.map(c => ({
      range: new mod.monaco.Range(c.start, 1, c.end, 1),
      options: { isWholeLine: true, className: 'ai-edit-line', linesDecorationsClassName: 'ai-edit-gutter' },
    })));
    setTimeout(() => deco.clear(), 6000);
    if (changed.length) this.ed.revealLinesInCenterIfOutsideViewport(changed[0].start, changed[0].end);
    return changed.map(c => c.start === c.end ? `line ${c.start}` : `lines ${c.start}-${c.end}`).join(', ');
  }

  /** Saves without dialogs; throws a readable error (e.g. on a conflict). */
  async aiSave() {
    const m = this.ed?.getModel();
    if (!m) throw new Error('editor not ready');
    const version = m.getAlternativeVersionId();
    try {
      this.stamp = await SaveEditedFile(this.sessionId, this.path, m.getValue(), this.stamp, false);
    } catch (e) {
      const msg = String(e);
      if (msg.startsWith('conflict:')) {
        await this.forceReload();
        throw new Error(`${this.path} was changed on the server meanwhile (${msg.slice(9).trim()}), so the edit was NOT saved; the editor now shows the server's version. Run open_file again and redo the edit.`);
      }
      throw e;
    }
    this.savedVersion = version;
    this.renderCrumb(); this.renderStatus(); this.onChange();
  }

  private async forceReload() {
    const m = this.ed?.getModel();
    if (!m) return;
    const file = await OpenFileForEdit(this.sessionId, this.path);
    this.stamp = file.stamp;
    m.setValue(file.content);
    this.savedVersion = m.getAlternativeVersionId();
    this.renderCrumb(); this.renderStatus(); this.onChange();
  }

  /** Current text in the editor. */
  text(): string { return this.ed?.getModel()?.getValue() ?? ''; }

  focus() { this.ed?.focus(); }

  setFontSize(size: number) { this.ed?.updateOptions({ fontSize: size }); }

  dispose() {
    this.offCompanion?.();
    const m = this.ed?.getModel();
    this.ed?.dispose();
    m?.dispose();
    this.el.remove();
  }
}
