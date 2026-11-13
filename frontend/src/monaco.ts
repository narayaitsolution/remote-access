// Monaco (the editor of VS Code), loaded lazily the first time a file is opened.
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

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

const SPECIAL_NAMES: Record<string, string> = {
  dockerfile: 'dockerfile', makefile: 'shell', '.bashrc': 'shell', '.profile': 'shell', '.bash_profile': 'shell',
  '.zshrc': 'shell', '.env': 'shell', 'nginx.conf': 'plaintext', 'crontab': 'shell', 'jenkinsfile': 'groovy',
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
    if (['.conf', '.cfg', '.service', '.timer', '.socket'].includes(ext)) return 'ini';
    if (['.log', '.txt'].includes(ext)) return 'plaintext';
  }
  return 'plaintext';
}

export function languageName(id: string): string {
  const l = monaco.languages.getLanguages().find(x => x.id === id);
  return l?.aliases?.[0] || id;
}

export { monaco };
