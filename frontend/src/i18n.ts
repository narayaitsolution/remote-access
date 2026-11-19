// UI language. Texts are written in Indonesian in the code and wrapped in t();
// in English the Indonesian text is looked up in EN (i18n-en.ts). {0}, {1}…
// are replaced by the arguments. The language comes from Go (GetState: the
// `language` setting, or the Windows display language when it is empty).
import { EN } from './i18n-en';

export type Lang = 'id' | 'en';
let lang: Lang = 'id';
const missing = new Set<string>();

export function setLang(l: string) {
  lang = l === 'en' ? 'en' : 'id';
  document.documentElement.lang = lang;
}
export const getLang = (): Lang => lang;

export function t(s: string, ...args: (string | number)[]): string { return tIn(lang, s, ...args); }

/** Like t, in a given language (e.g. to announce a language change in the new language). */
export function tIn(l: Lang, s: string, ...args: (string | number)[]): string {
  let r = s;
  if (l === 'en') {
    const en = EN[s];
    if (en !== undefined) r = en;
    else if (!missing.has(s)) { missing.add(s); console.warn('i18n: no English text for', JSON.stringify(s)); }
  }
  return args.length ? r.replace(/\{(\d+)\}/g, (m, i) => (+i < args.length ? String(args[+i]) : m)) : r;
}
