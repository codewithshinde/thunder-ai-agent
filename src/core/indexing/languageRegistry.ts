/**
 * Language registry: 100+ file extensions → language IDs, tree-sitter WASM grammars, and regex fallbacks.
 * WASM grammar names match tree-sitter-wasms/out/tree-sitter-{name}.wasm files.
 */

export interface RegexSymbolPattern {
  regex: RegExp;
  kind: string;
}

/** Extension or basename → internal language id */
const EXTENSION_MAP: Record<string, string> = {
  // A
  '.as': 'actionscript', '.adb': 'ada', '.ads': 'ada', '.agda': 'agda',
  '.ino': 'arduino', '.asm': 'asm', '.s': 'asm', '.astro': 'astro',
  // B
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
  '.bean': 'beancount', '.bib': 'bibtex', '.bicep': 'bicep',
  '.bb': 'bitbake', '.bbappend': 'bitbake', '.bbclass': 'bitbake',
  // C
  '.c': 'c', '.h': 'c', '.cairo': 'cairo', '.capnp': 'capnp',
  '.clj': 'clojure', '.cljs': 'clojure', '.cljc': 'clojure', '.edn': 'clojure',
  '.cmake': 'cmake', '.lisp': 'commonlisp', '.cl': 'commonlisp',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp', '.h++': 'cpp',
  '.cs': 'csharp', '.css': 'css', '.scss': 'scss', '.csv': 'csv',
  '.cu': 'cuda', '.cuh': 'cuda', '.d': 'd',
  // D
  '.dart': 'dart', '.dtd': 'dtd',
  // E
  '.el': 'elisp', '.ex': 'elixir', '.exs': 'elixir', '.elm': 'elm',
  '.erl': 'erlang', '.hrl': 'erlang', '.et': 'embedded_template',
  // F
  '.fnl': 'fennel', '.fish': 'fish',
  '.f': 'fortran', '.f90': 'fortran', '.f95': 'fortran', '.f03': 'fortran', '.f08': 'fortran',
  // G
  '.gd': 'gdscript', '.gleam': 'gleam', '.glsl': 'glsl', '.vert': 'glsl', '.frag': 'glsl',
  '.go': 'go', '.groovy': 'groovy',
  // H
  '.hack': 'hack', '.ha': 'hare', '.hs': 'haskell', '.hx': 'haxe',
  '.hcl': 'hcl', '.tf': 'hcl', '.tfvars': 'hcl', '.heex': 'heex', '.hlsl': 'hlsl',
  '.html': 'html', '.htm': 'html', '.hypr': 'hyprlang',
  // I–J
  '.ispc': 'ispc', '.janet': 'janet', '.java': 'java',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.jsdoc': 'jsdoc', '.json': 'json', '.jsonnet': 'jsonnet', '.libsonnet': 'jsonnet',
  '.jl': 'julia',
  // K–L
  '.kdl': 'kdl', '.kt': 'kotlin', '.kts': 'kotlin',
  '.tex': 'latex', '.sty': 'latex', '.cls': 'latex',
  '.ld': 'linkerscript', '.ll': 'llvm', '.td': 'tablegen',
  '.lua': 'lua', '.luau': 'luau',
  // M
  '.md': 'markdown', '.markdown': 'markdown',
  '.m': 'matlab', '.mat': 'matlab', '.mm': 'objc',
  '.ml': 'ocaml', '.mli': 'ocaml',
  // N–O
  '.nix': 'nix', '.odin': 'odin', '.org': 'org',
  // P
  '.pas': 'pascal', '.pp': 'pascal',
  '.pl': 'perl', '.pm': 'perl', '.php': 'php',
  '.ps1': 'powershell', '.psm1': 'powershell', '.proto': 'proto',
  '.purs': 'purescript', '.py': 'python', '.pyw': 'python', '.pyi': 'python',
  // Q–R
  '.qml': 'qmljs', '.r': 'r', '.R': 'r', '.rkt': 'racket',
  '.rb': 'ruby', '.rs': 'rust',
  // S
  '.scala': 'scala', '.sc': 'scala', '.scm': 'scheme', '.ss': 'scheme',
  '.smali': 'smali', '.sol': 'solidity', '.rq': 'sparql', '.sql': 'sql',
  '.nut': 'squirrel', '.bzl': 'starlark', '.svelte': 'svelte', '.swift': 'swift',
  // T
  '.tcl': 'tcl', '.thrift': 'thrift', '.toml': 'toml', '.tsv': 'tsv',
  '.ts': 'typescript', '.tsx': 'tsx', '.mts': 'typescript', '.cts': 'typescript',
  '.twig': 'twig', '.typ': 'typst',
  // U–V
  '.v': 'verilog', '.sv': 'verilog', '.vhd': 'vhdl', '.vhdl': 'vhdl',
  '.vim': 'vim', '.vue': 'vue',
  // W–Z
  '.wgsl': 'wgsl', '.xml': 'xml', '.svg': 'xml', '.xsl': 'xml',
  '.yaml': 'yaml', '.yml': 'yaml', '.zig': 'zig',
  '.ql': 'ql', '.rescript': 'rescript', '.res': 'rescript',
  // Special basenames
  Dockerfile: 'dockerfile',
  'CMakeLists.txt': 'cmake',
  'go.mod': 'gomod',
  'go.sum': 'gomod',
  Makefile: 'make',
  'meson.build': 'meson',
  BUILD: 'starlark',
  WORKSPACE: 'starlark',
  'requirements.txt': 'python',
};

/** Internal language id → tree-sitter-wasms grammar file name (without tree-sitter- prefix) */
export const WASM_GRAMMAR_NAMES: Record<string, string> = {
  bash: 'bash',
  c: 'c',
  cpp: 'cpp',
  csharp: 'c_sharp',
  css: 'css',
  dart: 'dart',
  elisp: 'elisp',
  elixir: 'elixir',
  elm: 'elm',
  embedded_template: 'embedded_template',
  go: 'go',
  html: 'html',
  java: 'java',
  javascript: 'javascript',
  json: 'json',
  kotlin: 'kotlin',
  lua: 'lua',
  objc: 'objc',
  ocaml: 'ocaml',
  php: 'php',
  python: 'python',
  ql: 'ql',
  rescript: 'rescript',
  ruby: 'ruby',
  rust: 'rust',
  scala: 'scala',
  solidity: 'solidity',
  swift: 'swift',
  toml: 'toml',
  tsx: 'tsx',
  typescript: 'typescript',
  vue: 'vue',
  yaml: 'yaml',
  zig: 'zig',
};

/** Regex fallback patterns for languages without WASM grammars */
const REGEX_PATTERNS: Record<string, RegexSymbolPattern[]> = {
  actionscript: [
    { regex: /^\s*(?:public|private|protected)?\s*class\s+(\w+)/, kind: 'class' },
    { regex: /^\s*(?:public|private|protected)?\s*function\s+(\w+)/, kind: 'function' },
  ],
  ada: [
    { regex: /^\s*package\s+(\w+)/, kind: 'package' },
    { regex: /^\s*(?:procedure|function)\s+(\w+)/, kind: 'function' },
  ],
  arduino: [
    { regex: /^\s*void\s+setup\s*\(/, kind: 'function' },
    { regex: /^\s*void\s+loop\s*\(/, kind: 'function' },
    { regex: /^\s*(?:void|int|float|double|char|bool)\s+(\w+)\s*\(/, kind: 'function' },
  ],
  asm: [
    { regex: /^(\w+):/, kind: 'label' },
  ],
  astro: [
    { regex: /^export\s+(?:const|function)\s+(\w+)/, kind: 'export' },
  ],
  beancount: [
    { regex: /^\d{4}-\d{2}-\d{2}\s+\*?\s*"([^"]+)"/, kind: 'transaction' },
  ],
  bicep: [
    { regex: /^(?:param|var|resource|module|output)\s+(\w+)/, kind: 'declaration' },
  ],
  clojure: [
    { regex: /^\s*\(defn\s+([\w\-\?]+)/, kind: 'function' },
    { regex: /^\s*\(def\s+([\w\-\?]+)/, kind: 'const' },
  ],
  commonlisp: [
    { regex: /^\s*\(defun\s+([\w\-\?]+)/, kind: 'function' },
    { regex: /^\s*\(defclass\s+([\w\-\?]+)/, kind: 'class' },
  ],
  cuda: [
    { regex: /^\s*__global__\s+(?:void|int|float)\s+(\w+)/, kind: 'function' },
    { regex: /^\s*(?:struct|class)\s+(\w+)/, kind: 'struct' },
  ],
  d: [
    { regex: /^\s*(?:class|struct|interface|enum)\s+(\w+)/, kind: 'type' },
    { regex: /^\s*(?:void|auto|int|string)\s+(\w+)\s*\(/, kind: 'function' },
  ],
  dockerfile: [
    { regex: /^FROM\s+(\S+)/, kind: 'from' },
  ],
  erlang: [
    { regex: /^(\w+)\s*\(/, kind: 'function' },
    { regex: /^-module\s*\(\s*(\w+)/, kind: 'module' },
  ],
  fennel: [
    { regex: /^\s*\(fn\s+([\w\-\?]+)/, kind: 'function' },
  ],
  fortran: [
    { regex: /^\s*(?:subroutine|function)\s+(\w+)/i, kind: 'function' },
    { regex: /^\s*module\s+(\w+)/i, kind: 'module' },
  ],
  gdscript: [
    { regex: /^class_name\s+(\w+)/, kind: 'class' },
    { regex: /^func\s+(\w+)/, kind: 'function' },
  ],
  gleam: [
    { regex: /^pub\s+fn\s+(\w+)/, kind: 'function' },
    { regex: /^pub\s+type\s+(\w+)/, kind: 'type' },
  ],
  groovy: [
    { regex: /^\s*(?:class|interface|enum|trait)\s+(\w+)/, kind: 'type' },
    { regex: /^\s*def\s+(\w+)/, kind: 'function' },
  ],
  hack: [
    { regex: /^\s*(?:class|interface|trait|enum)\s+(\w+)/, kind: 'type' },
    { regex: /^\s*(?:public|private|protected)?\s*function\s+(\w+)/, kind: 'function' },
  ],
  haskell: [
    { regex: /^(\w+)\s*::/, kind: 'signature' },
    { regex: /^(?:data|newtype|type|class)\s+(\w+)/, kind: 'type' },
  ],
  haxe: [
    { regex: /^\s*(?:class|interface|enum|typedef)\s+(\w+)/, kind: 'type' },
    { regex: /^\s*(?:public|private)?\s*function\s+(\w+)/, kind: 'function' },
  ],
  hcl: [
    { regex: /^(?:resource|variable|output|module|provider)\s+"([^"]+)"/, kind: 'block' },
  ],
  julia: [
    { regex: /^\s*(?:function|macro)\s+(\w+)/, kind: 'function' },
    { regex: /^\s*struct\s+(\w+)/, kind: 'struct' },
  ],
  latex: [
    { regex: /\\(?:newcommand|def)\s*\{?\\(\w+)/, kind: 'command' },
  ],
  make: [
    { regex: /^([\w\-.]+)\s*:/, kind: 'target' },
  ],
  matlab: [
    { regex: /^\s*function\s+(?:\[[\w,\s]+\]|\w+)\s*=\s*(\w+)/, kind: 'function' },
    { regex: /^\s*classdef\s+(\w+)/, kind: 'class' },
  ],
  nix: [
    { regex: /^(\w+)\s*=\s*/, kind: 'binding' },
  ],
  ocaml: [
    { regex: /^\s*(?:let|and)\s+(?:rec\s+)?(\w+)/, kind: 'function' },
    { regex: /^\s*(?:type|module|class)\s+(\w+)/, kind: 'type' },
  ],
  pascal: [
    { regex: /^\s*(?:procedure|function)\s+(\w+)/i, kind: 'function' },
  ],
  perl: [
    { regex: /^\s*sub\s+(\w+)/, kind: 'function' },
    { regex: /^\s*package\s+(\w+)/, kind: 'package' },
  ],
  powershell: [
    { regex: /^\s*function\s+(\w+)/i, kind: 'function' },
    { regex: /^\s*class\s+(\w+)/i, kind: 'class' },
  ],
  purescript: [
    { regex: /^\s*(?:data|type|class|instance|newtype)\s+(\w+)/, kind: 'type' },
  ],
  racket: [
    { regex: /^\s*\(define\s+\(?([\w\-\?]+)/, kind: 'function' },
  ],
  scheme: [
    { regex: /^\s*\(define\s+\(?([\w\-\?]+)/, kind: 'function' },
  ],
  sparql: [
    { regex: /^\s*(?:SELECT|CONSTRUCT|ASK|DESCRIBE)\b/i, kind: 'query' },
  ],
  sql: [
    { regex: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|FUNCTION|PROCEDURE)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/i, kind: 'definition' },
  ],
  starlark: [
    { regex: /^def\s+(\w+)/, kind: 'function' },
  ],
  svelte: [
    { regex: /^\s*(?:export\s+)?(?:const|let|function|class)\s+(\w+)/, kind: 'export' },
  ],
  tcl: [
    { regex: /^\s*proc\s+(\w+)/, kind: 'function' },
  ],
  verilog: [
    { regex: /^\s*module\s+(\w+)/, kind: 'module' },
  ],
  vhdl: [
    { regex: /^\s*(?:entity|architecture|package)\s+(\w+)/i, kind: 'declaration' },
  ],
  vim: [
    { regex: /^\s*function!\s+(\w+)/, kind: 'function' },
  ],
  wgsl: [
    { regex: /^\s*(?:fn|struct|var)\s+(\w+)/, kind: 'declaration' },
  ],
  xml: [
    { regex: /<(\w+)[\s>]/, kind: 'element' },
  ],
  // Languages with tree-sitter also get regex as fallback
  typescript: [
    { regex: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/, kind: 'class' },
    { regex: /^(?:export\s+)?interface\s+(\w+)/, kind: 'interface' },
    { regex: /^(?:export\s+)?(?:async\s+)?function\s+\*?\s*(\w+)/, kind: 'function' },
    { regex: /^(?:export\s+)?type\s+(\w+)/, kind: 'type' },
    { regex: /^(?:export\s+)?enum\s+(\w+)/, kind: 'enum' },
    { regex: /^(?:export\s+)?const\s+(\w+)\s*[=:]/, kind: 'const' },
  ],
  tsx: [
    { regex: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/, kind: 'class' },
    { regex: /^(?:export\s+)?(?:async\s+)?function\s+\*?\s*(\w+)/, kind: 'function' },
    { regex: /^(?:export\s+)?const\s+(\w+)\s*[=:]/, kind: 'const' },
  ],
  javascript: [
    { regex: /^(?:export\s+)?class\s+(\w+)/, kind: 'class' },
    { regex: /^(?:export\s+)?(?:async\s+)?function\s+\*?\s*(\w+)/, kind: 'function' },
    { regex: /^(?:export\s+)?const\s+(\w+)\s*[=:]/, kind: 'const' },
  ],
  python: [
    { regex: /^class\s+(\w+)/, kind: 'class' },
    { regex: /^(?:async\s+)?def\s+(\w+)/, kind: 'function' },
  ],
  java: [
    { regex: /(?:public|private|protected)?\s*(?:static\s+)?class\s+(\w+)/, kind: 'class' },
    { regex: /(?:public|private|protected)\s+\w+[\w<>,\s]*\s+(\w+)\s*\(/, kind: 'method' },
    { regex: /(?:public|private|protected)?\s*interface\s+(\w+)/, kind: 'interface' },
  ],
  go: [
    { regex: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/, kind: 'function' },
    { regex: /^type\s+(\w+)\s+struct/, kind: 'struct' },
    { regex: /^type\s+(\w+)\s+interface/, kind: 'interface' },
  ],
  rust: [
    { regex: /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/, kind: 'function' },
    { regex: /^(?:pub\s+)?struct\s+(\w+)/, kind: 'struct' },
    { regex: /^(?:pub\s+)?enum\s+(\w+)/, kind: 'enum' },
    { regex: /^(?:pub\s+)?trait\s+(\w+)/, kind: 'trait' },
    { regex: /^(?:pub\s+)?impl\s+(\w+)/, kind: 'impl' },
  ],
  ruby: [
    { regex: /^class\s+(\w+)/, kind: 'class' },
    { regex: /^module\s+(\w+)/, kind: 'module' },
    { regex: /^\s*def\s+(?:self\.)?(\w+)/, kind: 'method' },
  ],
  php: [
    { regex: /^(?:abstract\s+)?class\s+(\w+)/, kind: 'class' },
    { regex: /^(?:public|private|protected)?\s*function\s+(\w+)/, kind: 'function' },
    { regex: /^interface\s+(\w+)/, kind: 'interface' },
  ],
  csharp: [
    { regex: /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?class\s+(\w+)/, kind: 'class' },
    { regex: /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?interface\s+(\w+)/, kind: 'interface' },
    { regex: /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:async\s+)?\w+[\w<>,\s]*\s+(\w+)\s*\(/, kind: 'method' },
  ],
  c: [
    { regex: /^(?:static\s+)?(?:\w+\s+)+(\w+)\s*\([^;]*\)\s*\{/, kind: 'function' },
    { regex: /^typedef\s+struct\s+(\w+)/, kind: 'struct' },
  ],
  cpp: [
    { regex: /^(?:class|struct)\s+(\w+)/, kind: 'class' },
    { regex: /^(?:virtual\s+)?(?:\w+\s+)+(\w+)\s*\([^;]*\)\s*(?:const)?\s*\{/, kind: 'function' },
  ],
  kotlin: [
    { regex: /^(?:data\s+)?class\s+(\w+)/, kind: 'class' },
    { regex: /^fun\s+(\w+)/, kind: 'function' },
    { regex: /^interface\s+(\w+)/, kind: 'interface' },
  ],
  swift: [
    { regex: /^(?:public\s+|private\s+|internal\s+)?(?:class|struct|enum|protocol)\s+(\w+)/, kind: 'type' },
    { regex: /^\s*func\s+(\w+)/, kind: 'function' },
  ],
  scala: [
    { regex: /^(?:case\s+)?class\s+(\w+)/, kind: 'class' },
    { regex: /^(?:case\s+)?object\s+(\w+)/, kind: 'object' },
    { regex: /^def\s+(\w+)/, kind: 'function' },
    { regex: /^trait\s+(\w+)/, kind: 'trait' },
  ],
  lua: [
    { regex: /^function\s+(\w+)/, kind: 'function' },
    { regex: /^local\s+function\s+(\w+)/, kind: 'function' },
  ],
  elixir: [
    { regex: /^defmodule\s+(\w+)/, kind: 'module' },
    { regex: /^\s*def\s+(\w+)/, kind: 'function' },
  ],
  solidity: [
    { regex: /^contract\s+(\w+)/, kind: 'contract' },
    { regex: /^interface\s+(\w+)/, kind: 'interface' },
    { regex: /^\s*function\s+(\w+)/, kind: 'function' },
  ],
  zig: [
    { regex: /^pub\s+fn\s+(\w+)/, kind: 'function' },
    { regex: /^(?:pub\s+)?const\s+(\w+)/, kind: 'const' },
  ],
};

export function detectLanguageFromPath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  const basename = normalized.split('/').pop() ?? normalized;
  if (basename in EXTENSION_MAP) return EXTENSION_MAP[basename];
  const dot = basename.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = basename.slice(dot).toLowerCase();
  return EXTENSION_MAP[ext] ?? null;
}

export function getWasmGrammarName(language: string): string | null {
  return WASM_GRAMMAR_NAMES[language] ?? null;
}

export function getRegexPatterns(language: string): RegexSymbolPattern[] {
  return REGEX_PATTERNS[language] ?? [];
}

export function hasWasmGrammar(language: string): boolean {
  return language in WASM_GRAMMAR_NAMES;
}

export function getSupportedExtensionCount(): number {
  return Object.keys(EXTENSION_MAP).length;
}

export function getSupportedLanguageIds(): string[] {
  const langs = new Set(Object.values(EXTENSION_MAP));
  return [...langs].sort();
}

export function getWasmLanguageIds(): string[] {
  return Object.keys(WASM_GRAMMAR_NAMES).sort();
}
