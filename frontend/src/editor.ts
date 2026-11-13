// A remote file opened in the built-in editor (Monaco, like VS Code).
import { OpenFileForEdit, SaveEditedFile } from '../wailsjs/go/main/App';
import { store } from './state';
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
    const [{ monaco, languageFor, languageName }, file] = await Promise.all([loadMonaco(), OpenFileForEdit(this.sessionId, this.path)]);
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
      minimap: { enabled: true },
      renderWhitespace: 'selection',
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      mouseWheelZoom: false,
      tabSize: 4,
      detectIndentation: true,
      bracketPairColorization: { enabled: true },
      unicodeHighlight: { ambiguousCharacters: false },
    });
    this.savedVersion = model.getAlternativeVersionId();
    this.ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { this.save(); });
    model.onDidChangeContent(() => { this.renderCrumb(); this.renderStatus(); this.onChange(); });
    this.ed.onDidChangeCursorPosition(() => this.renderStatus());
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
    this.status.textContent = `Ln ${pos.lineNumber}, Col ${pos.column}   ·   ${opts.insertSpaces ? 'Spasi: ' + opts.tabSize : 'Tab: ' + opts.tabSize}   ·   UTF-8   ·   ${eol}   ·   ${this.langLabel}` +
      (this.dirty ? '   ·   belum disimpan' : '');
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
