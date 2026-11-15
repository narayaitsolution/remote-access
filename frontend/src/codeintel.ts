// Code completion for languages Monaco only colours: keywords, common built-ins
// and VS Code-style snippets (Tab jumps between placeholders). Words already in
// the file are suggested by Monaco itself (wordBasedSuggestions).
import type * as Monaco from 'monaco-editor';

interface LangPack {
  keywords: string[];
  builtins?: string[];
  snippets?: Record<string, [string, string]>; // label -> [description, body]
}

const PACKS: Record<string, LangPack> = {
  python: {
    keywords: 'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'.split(' '),
    builtins: 'print len range enumerate zip map filter sorted reversed sum min max abs round open input int float str bool list dict set tuple type isinstance issubclass getattr setattr hasattr super property staticmethod classmethod any all iter next repr format id hash dir vars ValueError TypeError KeyError IndexError Exception RuntimeError __name__ __init__ self'.split(' '),
    snippets: {
      def: ['function', 'def ${1:name}(${2:args}):\n\t${0:pass}'],
      class: ['class', 'class ${1:Name}:\n\tdef __init__(self${2:, args}):\n\t\t${0:pass}'],
      if: ['if statement', 'if ${1:condition}:\n\t${0:pass}'],
      ifelse: ['if/else', 'if ${1:condition}:\n\t${2:pass}\nelse:\n\t${0:pass}'],
      for: ['for loop', 'for ${1:item} in ${2:items}:\n\t${0:pass}'],
      while: ['while loop', 'while ${1:condition}:\n\t${0:pass}'],
      try: ['try/except', 'try:\n\t${1:pass}\nexcept ${2:Exception} as ${3:e}:\n\t${0:raise}'],
      with: ['with statement', 'with ${1:open(path)} as ${2:f}:\n\t${0:pass}'],
      main: ['main guard', 'if __name__ == "__main__":\n\t${0:main()}'],
      lambda: ['lambda', 'lambda ${1:x}: ${0:x}'],
    },
  },
  php: {
    keywords: 'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield null true false self parent'.split(' '),
    builtins: 'strlen str_replace strpos substr explode implode trim sprintf printf count array_map array_filter array_keys array_values array_merge in_array json_encode json_decode isset var_dump print_r date time file_get_contents file_put_contents htmlspecialchars preg_match preg_replace'.split(' '),
    snippets: {
      php: ['PHP open tag', '<?php\n\n$0'],
      function: ['function', 'function ${1:name}(${2:\\$arg})${3:: void}\n{\n\t$0\n}'],
      class: ['class', 'class ${1:Name}\n{\n\tpublic function __construct(${2})\n\t{\n\t\t$0\n\t}\n}'],
      if: ['if statement', 'if (${1:condition}) {\n\t$0\n}'],
      foreach: ['foreach loop', 'foreach (${1:\\$items} as ${2:\\$item}) {\n\t$0\n}'],
      for: ['for loop', 'for (${1:\\$i} = 0; ${1:\\$i} < ${2:\\$n}; ${1:\\$i}++) {\n\t$0\n}'],
      try: ['try/catch', 'try {\n\t$1\n} catch (${2:\\Exception} ${3:\\$e}) {\n\t$0\n}'],
      pubf: ['public method', 'public function ${1:name}(${2})${3:: void}\n{\n\t$0\n}'],
    },
  },
  java: {
    keywords: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record null true false'.split(' '),
    builtins: 'String System Integer Long Double Boolean Object List ArrayList Map HashMap Set HashSet Optional Exception RuntimeException Override StringBuilder Math Arrays Collections'.split(' '),
    snippets: {
      main: ['main method', 'public static void main(String[] args) {\n\t$0\n}'],
      sout: ['System.out.println', 'System.out.println(${0});'],
      class: ['class', 'public class ${1:Name} {\n\t$0\n}'],
      if: ['if statement', 'if (${1:condition}) {\n\t$0\n}'],
      for: ['for loop', 'for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t$0\n}'],
      foreach: ['for-each loop', 'for (${1:var} ${2:item} : ${3:items}) {\n\t$0\n}'],
      try: ['try/catch', 'try {\n\t$1\n} catch (${2:Exception} ${3:e}) {\n\t$0\n}'],
      method: ['method', 'public ${1:void} ${2:name}(${3}) {\n\t$0\n}'],
    },
  },
  go: {
    keywords: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota'.split(' '),
    builtins: 'append cap close complex copy delete imag len make new panic print println real recover error string int int64 float64 bool byte rune any fmt errors context'.split(' '),
    snippets: {
      func: ['function', 'func ${1:name}(${2}) ${3:error} {\n\t$0\n}'],
      main: ['main function', 'func main() {\n\t$0\n}'],
      iferr: ['if err != nil', 'if err != nil {\n\treturn ${0:err}\n}'],
      for: ['for loop', 'for ${1:i} := 0; ${1:i} < ${2:n}; ${1:i}++ {\n\t$0\n}'],
      forr: ['for range', 'for ${1:_}, ${2:v} := range ${3:items} {\n\t$0\n}'],
      struct: ['struct type', 'type ${1:Name} struct {\n\t$0\n}'],
    },
  },
  c: {
    keywords: 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while NULL'.split(' '),
    builtins: 'printf scanf malloc calloc free memcpy memset strlen strcpy strcmp fopen fclose fprintf size_t include define'.split(' '),
    snippets: {
      main: ['main function', 'int main(int argc, char *argv[]) {\n\t$0\n\treturn 0;\n}'],
      if: ['if statement', 'if (${1:condition}) {\n\t$0\n}'],
      for: ['for loop', 'for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t$0\n}'],
      while: ['while loop', 'while (${1:condition}) {\n\t$0\n}'],
      struct: ['struct', 'typedef struct {\n\t$0\n} ${1:Name};'],
    },
  },
  csharp: {
    keywords: 'abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while var async await record get set'.split(' '),
    builtins: 'Console WriteLine String List Dictionary Task Exception Math DateTime IEnumerable'.split(' '),
    snippets: {
      cw: ['Console.WriteLine', 'Console.WriteLine(${0});'],
      class: ['class', 'public class ${1:Name}\n{\n\t$0\n}'],
      if: ['if statement', 'if (${1:condition})\n{\n\t$0\n}'],
      foreach: ['foreach loop', 'foreach (var ${1:item} in ${2:items})\n{\n\t$0\n}'],
      try: ['try/catch', 'try\n{\n\t$1\n}\ncatch (${2:Exception} ${3:ex})\n{\n\t$0\n}'],
      prop: ['property', 'public ${1:int} ${2:Name} { get; set; }'],
    },
  },
  ruby: {
    keywords: 'alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require require_relative attr_accessor attr_reader puts'.split(' '),
    snippets: {
      def: ['method', 'def ${1:name}(${2})\n\t$0\nend'],
      class: ['class', 'class ${1:Name}\n\tdef initialize(${2})\n\t\t$0\n\tend\nend'],
      if: ['if statement', 'if ${1:condition}\n\t$0\nend'],
      each: ['each block', '${1:items}.each do |${2:item}|\n\t$0\nend'],
    },
  },
  rust: {
    keywords: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'.split(' '),
    builtins: 'println! print! format! vec! panic! Some None Ok Err Option Result String Vec Box HashMap'.split(' '),
    snippets: {
      fn: ['function', 'fn ${1:name}(${2}) ${3:-> ()} {\n\t$0\n}'],
      main: ['main function', 'fn main() {\n\t$0\n}'],
      struct: ['struct', 'struct ${1:Name} {\n\t$0\n}'],
      impl: ['impl block', 'impl ${1:Name} {\n\t$0\n}'],
      match: ['match', 'match ${1:value} {\n\t${2:_} => $0,\n}'],
      for: ['for loop', 'for ${1:item} in ${2:items} {\n\t$0\n}'],
    },
  },
  kotlin: {
    keywords: 'as break class continue do else false for fun if in interface is null object package return super this throw true try typealias val var when while by catch constructor data enum finally import init internal lateinit open override private protected public sealed suspend companion'.split(' '),
    snippets: {
      fun: ['function', 'fun ${1:name}(${2}): ${3:Unit} {\n\t$0\n}'],
      main: ['main function', 'fun main() {\n\t$0\n}'],
      class: ['class', 'class ${1:Name}(${2}) {\n\t$0\n}'],
      when: ['when', 'when (${1:value}) {\n\t${2:else} -> $0\n}'],
    },
  },
  shell: {
    keywords: 'if then else elif fi for while until do done case esac in function return local export readonly declare unset shift exit break continue source echo printf read test set trap'.split(' '),
    builtins: 'grep sed awk find xargs cut sort uniq head tail cat ls cp mv rm mkdir chmod chown curl wget tar systemctl journalctl'.split(' '),
    snippets: {
      shebang: ['bash shebang', '#!/usr/bin/env bash\nset -euo pipefail\n\n$0'],
      if: ['if statement', 'if [[ ${1:condition} ]]; then\n\t$0\nfi'],
      for: ['for loop', 'for ${1:item} in ${2:items}; do\n\t$0\ndone'],
      while: ['while loop', 'while ${1:condition}; do\n\t$0\ndone'],
      case: ['case', 'case "${1:\\$var}" in\n\t${2:pattern})\n\t\t$0\n\t\t;;\nesac'],
      func: ['function', '${1:name}() {\n\t$0\n}'],
    },
  },
  sql: {
    keywords: 'SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE ALTER DROP INDEX VIEW JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT OFFSET AS AND OR NOT NULL IS IN LIKE BETWEEN DISTINCT UNION ALL PRIMARY KEY FOREIGN REFERENCES DEFAULT COUNT SUM AVG MIN MAX CASE WHEN THEN ELSE END BEGIN COMMIT ROLLBACK'.split(' '),
    snippets: {
      sel: ['SELECT', 'SELECT ${1:*}\nFROM ${2:table}\nWHERE ${0:condition};'],
      ins: ['INSERT', 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${0:values});'],
      upd: ['UPDATE', 'UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${0:condition};'],
    },
  },
  lua: {
    keywords: 'and break do else elseif end false for function goto if in local nil not or repeat return then true until while'.split(' '),
    snippets: { function: ['function', 'function ${1:name}(${2})\n\t$0\nend'], for: ['for loop', 'for ${1:i} = 1, ${2:n} do\n\t$0\nend'] },
  },
  perl: {
    keywords: 'my our local sub if elsif else unless while until for foreach last next redo return use require package print die warn eval'.split(' '),
    snippets: { sub: ['subroutine', 'sub ${1:name} {\n\tmy (${2:\\$arg}) = @_;\n\t$0\n}'] },
  },
};
PACKS.cpp = {
  keywords: [...PACKS.c.keywords, ...'bool catch class constexpr delete explicit false friend namespace new noexcept nullptr operator override private protected public template this throw true try typename using virtual auto'.split(' ')],
  builtins: 'std cout cin endl string vector map unordered_map set unique_ptr shared_ptr make_unique make_shared size_t'.split(' '),
  snippets: { ...PACKS.c.snippets, class: ['class', 'class ${1:Name} {\npublic:\n\t${1:Name}();\n\t$0\n};'], cout: ['std::cout', 'std::cout << ${0} << std::endl;'] },
};
PACKS.powershell = {
  keywords: 'begin break catch class continue data do dynamicparam else elseif end exit filter finally for foreach function if in param process return switch throw trap try until while'.split(' '),
  builtins: 'Get-ChildItem Get-Content Set-Content Write-Host Write-Output Select-Object Where-Object ForEach-Object Test-Path New-Item Remove-Item'.split(' '),
};

let registered = false;

/** Registers completion providers once (safe to call repeatedly). */
export function registerCodeIntel(monaco: typeof Monaco) {
  if (registered) return;
  registered = true;
  const K = monaco.languages.CompletionItemKind;
  for (const [lang, pack] of Object.entries(PACKS)) {
    monaco.languages.registerCompletionItemProvider(lang, {
      provideCompletionItems(model, position) {
        const w = model.getWordUntilPosition(position);
        const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn };
        const items: Monaco.languages.CompletionItem[] = [];
        for (const k of pack.keywords) items.push({ label: k, kind: K.Keyword, insertText: k, range });
        for (const b of pack.builtins ?? []) items.push({ label: b, kind: K.Function, insertText: b, range });
        for (const [label, [doc, body]] of Object.entries(pack.snippets ?? {})) {
          items.push({
            label, kind: K.Snippet, detail: doc, documentation: { value: '```\n' + body.replace(/\$\{\d+:?([^}]*)\}|\$\d/g, '$1') + '\n```' },
            insertText: body, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range, sortText: '0' + label,
          });
        }
        return { suggestions: items };
      },
    });
  }
}
