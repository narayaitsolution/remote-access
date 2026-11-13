// File-type icons from Windows (the icon of the program each extension opens
// with, as in Explorer), cached per extension. Falls back to built-in icons.
import { FileIcons } from '../wailsjs/go/main/App';
import { icons } from './icons';
import { h } from './ui';

const cache = new Map<string, string>(); // key -> data URL ('' = none available)
const pending = new Map<string, Promise<void>>();

/** Cache key: ".pdf", "" for files without extension, "<dir>" for folders. */
function keyFor(name: string, isDir: boolean): string {
  if (isDir) return '<dir>';
  const m = name.toLowerCase().match(/(\.[a-z0-9_+-]{1,15})$/);
  return m && m[1] !== name.toLowerCase() ? m[1] : '';
}

/** Loads the icons for these entries (one request for all unknown extensions). */
export async function loadIcons(entries: { name: string; isDir: boolean }[]) {
  const want = [...new Set(entries.map(e => keyFor(e.name, e.isDir)))].filter(k => !cache.has(k));
  const waits = want.filter(k => pending.has(k)).map(k => pending.get(k)!);
  const todo = want.filter(k => !pending.has(k));
  if (todo.length) {
    const p = FileIcons(todo).then(res => {
      for (const k of todo) cache.set(k, res?.[k] ?? '');
    }).catch(() => { for (const k of todo) cache.set(k, ''); })
      .finally(() => todo.forEach(k => pending.delete(k)));
    todo.forEach(k => pending.set(k, p));
    waits.push(p);
  }
  await Promise.all(waits);
}

/** Icon element for a file or folder; Windows icon when known, else a built-in one. */
export function fileIcon(name: string, isDir: boolean): HTMLElement {
  const url = cache.get(keyFor(name, isDir));
  if (url) return h('img', { class: 'ficon', src: url, alt: '', draggable: 'false' });
  return h('span', { class: 'ficon-svg', html: isDir ? icons.folder : icons.file });
}
