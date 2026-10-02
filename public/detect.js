// Adivina qué tipo de contenido es un texto pegado, para proponer una extensión de fichero.
// Es orientativo: mira solo el principio del texto y, ante la duda, devuelve texto plano.

const TEXT_TYPE = { ext: 'txt', label: 'Texto' };

function detectType(text) {
  const trimmed = text.slice(0, 20000).trim();
  if (!trimmed) return TEXT_TYPE;

  const lines = trimmed.split('\n', 200).map((l) => l.trimEnd()).filter(Boolean);
  const first = lines[0];
  const count = (re) => lines.filter((l) => re.test(l)).length;
  const most = (re) => count(re) >= Math.max(2, lines.length * 0.6);
  const type = (ext, label) => ({ ext, label });

  if (first.startsWith('#!')) {
    if (/python/.test(first)) return type('py', 'Python');
    if (/node|deno|bun/.test(first)) return type('js', 'JavaScript');
    if (/ruby/.test(first)) return type('rb', 'Ruby');
    if (/perl/.test(first)) return type('pl', 'Perl');
    return type('sh', 'Shell');
  }
  if (/^-----BEGIN [A-Z0-9 ]+-----$/.test(first)) return type('pem', 'PEM');
  if (/^diff --git /.test(first) || (count(/^(---|\+\+\+) \S/) >= 2 && count(/^@@ .+ @@/) >= 1)) {
    return type('diff', 'Diff');
  }

  if (/^[{[]/.test(first)) {
    if (text.length < 20e6) {
      try {
        JSON.parse(text);
        return type('json', 'JSON');
      } catch {}
    } else if (/[}\]]\s*$/.test(text.slice(-100))) {
      return type('json', 'JSON');
    }
    const isJson = (line) => {
      try {
        return typeof JSON.parse(line) === 'object';
      } catch {
        return false;
      }
    };
    // Se ignora la última línea de la muestra: puede estar cortada.
    if (lines.length >= 3 && lines.slice(0, -1).every(isJson)) return type('jsonl', 'JSON Lines');
  }

  if (first.startsWith('<')) {
    if (/^<\?php/.test(first)) return type('php', 'PHP');
    if (/^<svg[\s>]/i.test(first) || (/^<\?xml/.test(first) && /<svg[\s>]/i.test(trimmed))) return type('svg', 'SVG');
    if (/^<\?xml/.test(first)) return type('xml', 'XML');
    if (/^<!doctype html/i.test(first) || /<(html|body|head|div|span|p|a|script|style|table|ul|ol|h[1-6]|img|section|form|button)[\s>]/i.test(trimmed)) {
      return type('html', 'HTML');
    }
    if (/^<[\w:.-]+[\s>]/.test(first) && /<\/[\w:.-]+>\s*$/.test(lines[lines.length - 1])) return type('xml', 'XML');
  }

  const fences = count(/^\s*```/);
  if (fences >= 2) return type('md', 'Markdown');

  if (
    most(/^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/) ||
    most(/^\[?\d{2}:\d{2}:\d{2}[.,]\d+/) ||
    most(/^[A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} /) ||
    most(/\b(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b/)
  ) {
    return type('log', 'Log');
  }

  const firstCode = lines.find((l) => !/^\s*(--|\/\*|#)/.test(l)) || '';
  if (
    /^\s*(select\s|insert\s+into\s|update\s+\S+\s+set\s|delete\s+from\s|create\s+(or\s+replace\s+)?(table|index|view|function|database)\s|alter\s+table\s|drop\s+(table|index|view)\s|with\s+\w+\s+as\s*\()/i.test(firstCode)
  ) {
    return type('sql', 'SQL');
  }

  // Lenguajes de programación: hacen falta al menos dos líneas características.
  if (count(/^\s*#include\s*[<"]/) >= 1) {
    return /\b(std::|cout|cin|template\s*<|class\s+\w+|namespace\s+\w+)|#include\s*<(iostream|string|vector|map)>/.test(trimmed)
      ? type('cpp', 'C++')
      : type('c', 'C');
  }
  if (/^package \w+$/.test(firstCode) && count(/^(func|import|type|var|const)\b/) >= 1) return type('go', 'Go');
  if (count(/\bfn \w+\s*[(<]/) >= 1 && count(/\b(let (mut )?\w+|impl\b|use \w+(::\w+)+|->|pub (fn|struct|enum)|println!)/) >= 2) {
    return type('rs', 'Rust');
  }
  if (count(/^\s*using [\w.]+;$/) >= 1 && count(/\b(namespace|class|void|public|private)\b/) >= 1) return type('cs', 'C#');
  if (count(/^\s*(public|private|protected)\s+(static\s+|final\s+|abstract\s+)*(class|interface|enum|void|[\w<>[\]]+\s+\w+\s*\()/) >= 1 && count(/[;{}]$/) >= 2) {
    return type('java', 'Java');
  }

  const python =
    count(/^\s*(def|class) \w+.*:$/) +
    count(/^(from [\w.]+ )?import [\w.*, ]+( as \w+)?$/) +
    count(/^\s*(if|elif|for|while|with|try|except|else|finally)\b.*:$/) +
    count(/^\s*(print\(|return\b|self\.|@\w+)/);
  const javascript =
    count(/^\s*(export\s+)?(default\s+)?(async\s+)?function\b\*?\s*\w*\s*\(/) +
    count(/^\s*(export\s+)?(const|let|var)\s+[\w{[]/) +
    count(/=>\s*[{(\w]/) +
    count(/^\s*import\s.+\sfrom\s+['"]|\brequire\(['"]/) +
    count(/\b(console\.\w+\(|document\.|window\.|module\.exports|await\s)/);
  if (python >= 2 && python >= javascript) return type('py', 'Python');
  if (javascript >= 2) {
    const typed =
      count(/^\s*(export\s+)?(interface|type|enum)\s+\w+/) +
      count(/[\w)\]]\s*:\s*(string|number|boolean|void|unknown|any|never|Promise<|Record<|Array<)\b/) +
      count(/\bas (const|string|number|unknown|any)\b/);
    return typed >= 1 ? type('ts', 'TypeScript') : type('js', 'JavaScript');
  }
  if (count(/^\s*[a-z-]+\s*:\s*[^;{}]+;$/) >= 2 && count(/[{}]/) >= 2) return type('css', 'CSS');
  if (count(/^\s*(if \[|then$|fi$|do$|done$|esac$|echo |export \w+=|sudo |cd |function \w+\s*\(\)|\w+=\$\()/) >= 2) {
    return type('sh', 'Shell');
  }

  // Datos tabulares: el mismo número de separadores en todas las líneas.
  if (lines.length >= 2) {
    const body = lines.slice(0, -1);
    const sameCount = (separator) => {
      const counts = body.map((l) => l.replace(/"[^"]*"/g, '').split(separator).length - 1);
      return counts[0] >= 1 && counts.every((c) => c === counts[0]) ? counts[0] : 0;
    };
    const enough = (n) => n >= 2 || (n === 1 && body.length >= 3);
    if (enough(sameCount('\t'))) return type('tsv', 'TSV');
    if (enough(sameCount(',')) || enough(sameCount(';'))) return type('csv', 'CSV');
  }

  const content = lines.filter((l) => !/^\s*#/.test(l));
  if (content.length && content.every((l) => /^(export )?[A-Z_][A-Z0-9_]*=/.test(l))) {
    return type('env', 'Variables de entorno');
  }
  if (count(/^\[\[?[\w. "-]+\]\]?$/) >= 1 && count(/^[\w."-]+\s*=\s*\S/) >= 1) {
    return count(/^\[\[.+\]\]$/) || count(/=\s*("|'|\[|\{|true$|false$)/) ? type('toml', 'TOML') : type('ini', 'INI');
  }

  const yamlLines = content.filter((l) => /^\s*(- )?[\w."'-]+:(\s.*)?$/.test(l) || /^\s*- \S/.test(l)).length;
  const yamlKeys = count(/^\s*(- )?[\w."'-]+:(\s.*)?$/);
  if (first === '---' || (yamlKeys >= 2 && yamlLines >= content.length * 0.8 && !count(/[;{]$/))) {
    return type('yaml', 'YAML');
  }

  const markdown = [
    count(/^#{1,6} \S/) >= 1,
    count(/^\s*([-*+]|\d+\.) \S/) >= 2,
    /\[[^\]\n]+\]\([^)\s]+\)/.test(trimmed),
    /(\*\*|__)[^*_\s][^*_\n]*(\*\*|__)/.test(trimmed),
    count(/^> \S/) >= 1,
    count(/^\|.+\|$/) >= 2,
    fences >= 1,
  ].filter(Boolean).length;
  if (markdown >= 2) return type('md', 'Markdown');

  return TEXT_TYPE;
}
