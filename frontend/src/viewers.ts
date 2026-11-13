// Read-only viewers for PDF and images, and a Markdown view with preview/edit.
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { ReadFileBase64 } from '../wailsjs/go/main/App';
import { EditorView } from './editor';
import { h } from './ui';

/** Common shape of everything that can be shown in an editor-like tab. */
export interface FileView {
  el: HTMLElement;
  path: string;
  sessionId: string;
  readonly fileName: string;
  readonly dirty: boolean;
  load(): Promise<void>;
  save(): Promise<boolean>;
  focus(): void;
  setFontSize(size: number): void;
  dispose(): void;
}

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif',
};
export const OFFICE_EXT = new Set(['doc', 'docx', 'docm', 'rtf', 'odt', 'xls', 'xlsx', 'xlsm', 'csv-office', 'ods', 'ppt', 'pptx', 'odp']);

export const extOf = (name: string) => (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '');

/** Creates the right view for a file name. */
export function viewFor(sessionId: string, path: string, onChange: () => void): FileView {
  const ext = extOf(path);
  if (ext === 'pdf') return new PdfView(sessionId, path);
  if (IMAGE_TYPES[ext]) return new ImageView(sessionId, path);
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return new MarkdownView(sessionId, path, onChange);
  return new EditorView(sessionId, path, onChange);
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

abstract class ReadOnlyView implements FileView {
  el: HTMLElement;
  protected bar: HTMLElement;
  protected body: HTMLElement;
  constructor(public sessionId: string, public path: string) {
    this.bar = h('div', { class: 'ed-crumb', title: path },
      h('span', { class: 'ed-path' }, path.slice(0, path.lastIndexOf('/') + 1)),
      h('span', { class: 'ed-file' }, this.fileName),
      h('span', { class: 'ed-spacer' }));
    this.body = h('div', { class: 'viewer-body', tabindex: '0' }, h('div', { class: 'ed-loading' }, 'Membuka ' + path + ' …'));
    this.el = h('div', { class: 'editor-view' }, this.bar, this.body);
  }
  get fileName() { return this.path.split('/').pop() || this.path; }
  get dirty() { return false; }
  abstract load(): Promise<void>;
  async save() { return true; }
  focus() { this.body.focus(); }
  setFontSize(_size: number) {}
  dispose() { this.el.remove(); }
}

class ImageView extends ReadOnlyView {
  private url = '';
  async load() {
    const b64 = await ReadFileBase64(this.sessionId, this.path);
    const blob = new Blob([b64ToBytes(b64)], { type: IMAGE_TYPES[extOf(this.path)] });
    this.url = URL.createObjectURL(blob);
    const img = h('img', { class: 'img-view', src: this.url, alt: this.fileName });
    img.addEventListener('load', () => this.bar.append(h('span', { class: 'ed-meta' }, `${img.naturalWidth} × ${img.naturalHeight}`)));
    img.addEventListener('click', () => img.classList.toggle('actual'));
    this.body.replaceChildren(h('div', { class: 'img-wrap' }, img));
  }
  dispose() { if (this.url) URL.revokeObjectURL(this.url); super.dispose(); }
}

class PdfView extends ReadOnlyView {
  private doc: any = null;
  private scale = 1.25;
  private zoomLabel = h('span', { class: 'ed-meta' });
  private pages = h('div', { class: 'pdf-pages' });
  private observer: IntersectionObserver | null = null;

  async load() {
    const pdfjs = await import('pdfjs-dist');
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const data = b64ToBytes(await ReadFileBase64(this.sessionId, this.path));
    this.doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
    const btn = (label: string, title: string, fn: () => void) => h('button', { class: 'btn small', title, onclick: fn }, label);
    this.bar.append(
      h('span', { class: 'ed-meta' }, `${this.doc.numPages} halaman`),
      btn('−', 'Perkecil', () => this.zoom(this.scale / 1.2)),
      this.zoomLabel,
      btn('+', 'Perbesar', () => this.zoom(this.scale * 1.2)),
      btn('Lebar', 'Sesuaikan lebar', () => this.fitWidth()));
    this.body.replaceChildren(this.pages);
    await this.fitWidth();
  }

  private async fitWidth() {
    if (!this.doc) return;
    const page = await this.doc.getPage(1);
    const w = page.getViewport({ scale: 1 }).width;
    await this.zoom(Math.max(0.3, (this.body.clientWidth - 48) / w));
  }

  /** Re-creates page placeholders; pages render when scrolled into view. */
  private async zoom(scale: number) {
    this.scale = Math.min(5, Math.max(0.25, scale));
    this.zoomLabel.textContent = Math.round(this.scale * 100) + '%';
    this.observer?.disconnect();
    this.observer = new IntersectionObserver(entries => {
      for (const e of entries) if (e.isIntersecting) this.renderPage(e.target as HTMLElement);
    }, { root: this.body, rootMargin: '600px 0px' });
    const first = await this.doc.getPage(1);
    const vp = first.getViewport({ scale: this.scale });
    const holders: HTMLElement[] = [];
    for (let i = 1; i <= this.doc.numPages; i++) {
      const holder = h('div', { class: 'pdf-page' });
      holder.dataset.page = String(i);
      holder.style.width = vp.width + 'px';
      holder.style.height = vp.height + 'px';
      holders.push(holder);
    }
    this.pages.replaceChildren(...holders);
    holders.forEach(x => this.observer!.observe(x));
  }

  private async renderPage(holder: HTMLElement) {
    if (holder.dataset.rendered === String(this.scale)) return;
    holder.dataset.rendered = String(this.scale);
    const page = await this.doc.getPage(Number(holder.dataset.page));
    const vp = page.getViewport({ scale: this.scale });
    const ratio = window.devicePixelRatio || 1;
    const canvas = h('canvas', {});
    canvas.width = Math.floor(vp.width * ratio);
    canvas.height = Math.floor(vp.height * ratio);
    canvas.style.width = vp.width + 'px';
    canvas.style.height = vp.height + 'px';
    holder.style.width = vp.width + 'px';
    holder.style.height = vp.height + 'px';
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined }).promise;
    if (holder.dataset.rendered === String(this.scale)) holder.replaceChildren(canvas);
  }

  dispose() { this.observer?.disconnect(); this.doc?.destroy(); super.dispose(); }
}

/** Markdown: rendered preview by default, "Edit" switches to the code editor. */
class MarkdownView implements FileView {
  el: HTMLElement;
  private editor: EditorView;
  private preview = h('div', { class: 'md-preview', tabindex: '0' });
  private btnPreview: HTMLButtonElement;
  private btnEdit: HTMLButtonElement;
  private mode: 'preview' | 'edit' = 'preview';

  constructor(public sessionId: string, public path: string, onChange: () => void) {
    this.editor = new EditorView(sessionId, path, onChange);
    this.btnPreview = h('button', { type: 'button', class: 'seg-btn', onclick: () => this.setMode('preview') }, 'Preview');
    this.btnEdit = h('button', { type: 'button', class: 'seg-btn', onclick: () => this.setMode('edit') }, 'Edit');
    const bar = h('div', { class: 'ed-crumb md-bar', title: path },
      h('span', { class: 'ed-path' }, path.slice(0, path.lastIndexOf('/') + 1)),
      h('span', { class: 'ed-file' }, this.editor.fileName),
      h('span', { class: 'ed-spacer' }),
      h('span', { class: 'ed-meta' }, 'Markdown'),
      h('div', { class: 'seg' }, this.btnPreview, this.btnEdit));
    this.el = h('div', { class: 'md-view' }, bar, this.editor.el, this.preview);
  }
  get fileName() { return this.editor.fileName; }
  get dirty() { return this.editor.dirty; }

  async load() {
    await this.editor.load();
    this.setMode('preview');
  }

  private setMode(mode: 'preview' | 'edit') {
    this.mode = mode;
    if (mode === 'preview') this.render();
    this.editor.el.classList.toggle('hidden', mode === 'preview');
    this.preview.classList.toggle('hidden', mode !== 'preview');
    this.btnPreview.classList.toggle('on', mode === 'preview');
    this.btnEdit.classList.toggle('on', mode === 'edit');
    this.focus();
  }

  private render() {
    const html = marked.parse(this.editor.text(), { async: false, gfm: true }) as string;
    // Content comes from the server: strip scripts, event handlers, iframes, forms.
    this.preview.innerHTML = DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'iframe', 'form', 'object', 'embed'] });
    for (const a of this.preview.querySelectorAll('a')) a.addEventListener('click', e => e.preventDefault());
  }

  save() { return this.editor.save(); }
  focus() { if (this.mode === 'preview') this.preview.focus(); else this.editor.focus(); }
  setFontSize(size: number) { this.editor.setFontSize(size); }
  dispose() { this.editor.dispose(); this.el.remove(); }
}
