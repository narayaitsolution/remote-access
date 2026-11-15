// Monaco (the editor of VS Code), loaded lazily the first time a file is opened.
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { registerCodeIntel } from './codeintel';

(self as any).MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

// Server files are edited in isolation, so don't flag unresolved imports etc.
monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
registerCodeIntel(monaco);

const SPECIAL_NAMES: Record<string, string> = {
  dockerfile: 'dockerfile', makefile: 'shell', '.bashrc': 'shell', '.profile': 'shell', '.bash_profile': 'shell',
  '.zshrc': 'shell', '.env': 'shell', 'nginx.conf': 'plaintext', 'crontab': 'shell', 'jenkinsfile': 'java',
  'gemfile': 'ruby', 'rakefile': 'ruby', 'vagrantfile': 'ruby', 'cmakelists.txt': 'plaintext',
};

// Extensions Monaco doesn't map itself, sent to the closest language it knows.
const EXTRA_EXT: Record<string, string> = {
  '.vue': 'html', '.svelte': 'html', '.jsp': 'html', '.ejs': 'html', '.gradle': 'java', '.groovy': 'java',
  '.ino': 'cpp', '.cc': 'cpp', '.hh': 'cpp', '.inc': 'php', '.phtml': 'php', '.module': 'php',
  '.zsh': 'shell', '.ksh': 'shell', '.fish': 'shell', '.cjs': 'javascript', '.mjs': 'javascript', '.mts': 'typescript', '.cts': 'typescript',
};

/** Picks a Monaco language id from a file name. */
export function languageFor(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (SPECIAL_NAMES[lower]) return SPECIAL_NAMES[lower];
  if (lower.startsWith('dockerfile')) return 'dockerfile';
  if (lower.startsWith('.env')) return 'shell';
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some(f => f.toLowerCase() === lower)) return lang.id;
  }
  const dot = lower.lastIndexOf('.');
  if (dot >= 0) {
    const ext = lower.slice(dot);
    for (const lang of monaco.languages.getLanguages()) {
      if (lang.extensions?.some(e => e.toLowerCase() === ext)) return lang.id;
    }
    if (EXTRA_EXT[ext]) return EXTRA_EXT[ext];
    if (['.conf', '.cfg', '.service', '.timer', '.socket', '.toml'].includes(ext)) return 'ini';
    if (['.log', '.txt'].includes(ext)) return 'plaintext';
  }
  return 'plaintext';
}

export function languageName(id: string): string {
  const l = monaco.languages.getLanguages().find(x => x.id === id);
  return l?.aliases?.[0] || id;
}

/** All languages for the language picker, sorted by display name. */
export function languageList(): { id: string; name: string }[] {
  return monaco.languages.getLanguages().map(l => ({ id: l.id, name: l.aliases?.[0] || l.id }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export { monaco };
