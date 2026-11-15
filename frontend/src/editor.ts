// A remote file opened in the built-in editor (Monaco, like VS Code).
import { OpenFileForEdit, SaveEditedFile } from '../wailsjs/go/main/App';
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
      h('button', { class: 'ed-st-btn', title: 'Ganti bahasa (Ctrl+K M)', onclick: () => this.pickLanguage() }, this.langLabel));
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

  /** Current text in the editor. */
  text(): string { return this.ed?.getModel()?.getValue() ?? ''; }

  focus() { this.ed?.focus(); }

  setFontSize(size: number) { this.ed?.updateOptions({ fontSize: size }); }

  dispose() {
    const m = this.ed?.getModel();
    this.ed?.dispose();
    m?.dispose();
    this.el.remove();
  }
}
