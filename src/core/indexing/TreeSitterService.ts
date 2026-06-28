import { join } from 'path';
import type { ExtractedSymbol } from './SymbolExtractor';
import { getWasmGrammarName, hasWasmGrammar } from './languageRegistry';
import { getTagQuery } from './tagQueries';

type WasmParser = {
  init(): Promise<void>;
  Language: {
    load(path: string): Promise<unknown>;
  };
  Parser: new () => {
    setLanguage(lang: unknown): void;
    parse(content: string): { rootNode: WasmNode };
  };
};

type WasmNode = {
  type: string;
  text: string;
  startPosition: { row: number };
  endPosition: { row: number };
  childCount: number;
  child(index: number): WasmNode | null;
  namedChild(name: string): WasmNode | null;
};

type WasmLanguage = {
  query(source: string): {
    captures(node: WasmNode): Array<{ name: string; node: WasmNode }>;
  };
};

type NativeParser = {
  setLanguage(lang: unknown): void;
  parse(content: string): { rootNode: WasmNode };
};

type TreeSitterModule = {
  Parser: new () => NativeParser;
};

const DEFINITION_TYPES = [
  'class_declaration', 'interface_declaration', 'function_declaration',
  'method_definition', 'method_declaration', 'type_alias_declaration',
  'enum_declaration', 'lexical_declaration', 'function_definition',
  'class_definition', 'type_declaration', 'function_item', 'struct_item',
  'enum_item', 'trait_item', 'impl_item', 'class', 'module', 'method',
  'singleton_method', 'contract_declaration', 'variable_declaration',
  'class_specifier', 'struct_specifier', 'function_definition',
  'class_declaration', 'interface_declaration', 'protocol_declaration',
  'struct_declaration', 'enum_declaration', 'object_definition',
  'trait_definition', 'value_definition', 'type_definition',
  'module_definition', 'let_declaration', 'type_declaration',
  'class_interface', 'function_signature', 'method_signature',
];

let wasmInitPromise: Promise<boolean> | null = null;
let wasmReady = false;
let wasmParser: InstanceType<WasmParser['Parser']> | null = null;
const wasmLanguageCache = new Map<string, WasmLanguage | null>();

let nativeParser: NativeParser | null = null;
let nativeInitFailed = false;
const nativeLanguageCache = new Map<string, unknown>();

const NATIVE_PACKAGES: Record<string, string> = {
  typescript: 'tree-sitter-typescript',
  javascript: 'tree-sitter-javascript',
  python: 'tree-sitter-python',
  go: 'tree-sitter-go',
  java: 'tree-sitter-java',
};

function loadWasmModule(): WasmParser | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('web-tree-sitter') as WasmParser;
  } catch {
    return null;
  }
}

function resolveWasmPath(grammarName: string): string | null {
  try {
    const pkgJson = require.resolve('tree-sitter-wasms/package.json');
    return join(pkgJson, '..', 'out', `tree-sitter-${grammarName}.wasm`);
  } catch {
    return null;
  }
}

/** Initialize web-tree-sitter WASM runtime. Call once at workspace startup. */
export async function initTreeSitter(): Promise<boolean> {
  if (wasmReady) return true;
  if (wasmInitPromise) return wasmInitPromise;

  wasmInitPromise = (async () => {
    const mod = loadWasmModule();
    if (!mod) return false;
    try {
      await mod.init();
      wasmParser = new mod.Parser();
      wasmReady = true;
      return true;
    } catch {
      return false;
    }
  })();

  return wasmInitPromise;
}

export function isTreeSitterInitialized(): boolean {
  return wasmReady;
}

function loadNativeParser(): NativeParser | null {
  if (nativeInitFailed) return null;
  if (nativeParser) return nativeParser;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const TreeSitter = require('tree-sitter') as TreeSitterModule;
    nativeParser = new TreeSitter.Parser();
    return nativeParser;
  } catch {
    nativeInitFailed = true;
    return null;
  }
}

function loadNativeLanguage(language: string): unknown | null {
  if (nativeLanguageCache.has(language)) return nativeLanguageCache.get(language) ?? null;
  const pkg = NATIVE_PACKAGES[language];
  if (!pkg) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(pkg) as Record<string, unknown>;
    const lang =
      mod.typescript ?? mod.javascript ?? mod.python ?? mod.go ?? mod.java ?? mod.default ?? mod;
    nativeLanguageCache.set(language, lang);
    return lang;
  } catch {
    nativeLanguageCache.set(language, null);
    return null;
  }
}

async function loadWasmLanguage(language: string): Promise<WasmLanguage | null> {
  if (wasmLanguageCache.has(language)) return wasmLanguageCache.get(language) ?? null;
  const grammarName = getWasmGrammarName(language);
  if (!grammarName || !wasmParser) return null;

  const wasmPath = resolveWasmPath(grammarName);
  if (!wasmPath) return null;

  try {
    const mod = loadWasmModule();
    if (!mod) return null;
    const lang = (await mod.Language.load(wasmPath)) as WasmLanguage;
    wasmLanguageCache.set(language, lang);
    return lang;
  } catch {
    wasmLanguageCache.set(language, null);
    return null;
  }
}

function nodeKind(nodeType: string): string {
  if (nodeType.includes('class')) return 'class';
  if (nodeType.includes('interface')) return 'interface';
  if (nodeType.includes('struct')) return 'struct';
  if (nodeType.includes('trait')) return 'trait';
  if (nodeType.includes('enum')) return 'enum';
  if (nodeType.includes('method')) return 'method';
  if (nodeType.includes('function') || nodeType.includes('func')) return 'function';
  if (nodeType.includes('module')) return 'module';
  if (nodeType.includes('contract')) return 'contract';
  if (nodeType.includes('type')) return 'type';
  if (nodeType.includes('variable') || nodeType.includes('const') || nodeType.includes('let')) return 'const';
  return 'symbol';
}

function nodeName(node: WasmNode): string | null {
  const nameNode =
    node.namedChild?.('name') ??
    node.namedChild?.('type_identifier') ??
    node.namedChild?.('identifier') ??
    node.namedChild?.('property_identifier') ??
    node.namedChild?.('constant') ??
    node.namedChild?.('simple_identifier');
  return nameNode?.text?.trim() ?? null;
}

function walkDefinitions(node: WasmNode, symbols: ExtractedSymbol[], content: string, depth = 0): void {
  if (depth > 40) return;
  const type = node.type ?? '';

  if (DEFINITION_TYPES.some((t) => type.includes(t))) {
    const name = nodeName(node);
    if (name && name.length > 1 && !/^(default|exports?|self)$/.test(name)) {
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition ? node.endPosition.row + 1 : null;
      if (!symbols.some((s) => s.name === name && s.startLine === startLine)) {
        const lines = content.split('\n');
        const sigLine = lines[startLine - 1]?.trim().slice(0, 120) ?? null;
        symbols.push({
          name,
          kind: nodeKind(type),
          signature: sigLine,
          startLine,
          endLine,
        });
      }
    }
  }

  const count = node.childCount ?? 0;
  for (let i = 0; i < count; i++) {
    const child = node.child(i);
    if (child) walkDefinitions(child, symbols, content, depth + 1);
  }
}

function extractWithQuery(
  lang: WasmLanguage,
  rootNode: WasmNode,
  content: string,
  language: string
): ExtractedSymbol[] {
  const querySource = getTagQuery(language);
  if (!querySource) return [];

  try {
    const query = lang.query(querySource);
    const captures = query.captures(rootNode);
    const defNodes = new Map<string, WasmNode>();

    for (const cap of captures) {
      if (cap.name === 'def') {
        const nameCap = captures.find(
          (c) => c.name === 'name' && c.node.startPosition.row === cap.node.startPosition.row
        );
        const name = nameCap?.node.text?.trim() ?? nodeName(cap.node);
        if (name) defNodes.set(`${name}:${cap.node.startPosition.row}`, cap.node);
      }
    }

    // Pair @name captures with their @def nodes
    const symbols: ExtractedSymbol[] = [];
    const seen = new Set<string>();

    for (const cap of captures) {
      if (cap.name !== 'name') continue;
      const name = cap.node.text?.trim();
      if (!name || name.length < 2 || seen.has(`${name}:${cap.node.startPosition.row}`)) continue;

      const defCap = captures.find(
        (c) => c.name === 'def' && c.node.startPosition.row <= cap.node.startPosition.row
          && c.node.endPosition.row >= cap.node.startPosition.row
      );
      const defNode = defCap?.node ?? cap.node;
      const startLine = defNode.startPosition.row + 1;
      const endLine = defNode.endPosition ? defNode.endPosition.row + 1 : null;
      const lines = content.split('\n');
      const sigLine = lines[startLine - 1]?.trim().slice(0, 120) ?? null;

      seen.add(`${name}:${cap.node.startPosition.row}`);
      symbols.push({
        name,
        kind: nodeKind(defNode.type),
        signature: sigLine,
        startLine,
        endLine,
      });
    }

    return symbols;
  } catch {
    return [];
  }
}

function parseWithWasm(content: string, language: string): ExtractedSymbol[] {
  if (!wasmReady || !wasmParser) return [];
  const lang = wasmLanguageCache.get(language);
  if (!lang) return [];

  try {
    wasmParser.setLanguage(lang);
    const tree = wasmParser.parse(content);
    const querySymbols = extractWithQuery(lang, tree.rootNode, content, language);
    if (querySymbols.length > 0) return querySymbols.slice(0, 200);
    const symbols: ExtractedSymbol[] = [];
    walkDefinitions(tree.rootNode, symbols, content);
    return symbols.slice(0, 200);
  } catch {
    return [];
  }
}

function parseWithNative(content: string, language: string): ExtractedSymbol[] {
  const parser = loadNativeParser();
  const lang = loadNativeLanguage(language);
  if (!parser || !lang) return [];

  try {
    parser.setLanguage(lang);
    const tree = parser.parse(content);
    const symbols: ExtractedSymbol[] = [];
    walkDefinitions(tree.rootNode, symbols, content);
    return symbols.slice(0, 200);
  } catch {
    return [];
  }
}

/** Pre-load WASM grammar for a language (async). */
export async function preloadWasmLanguage(language: string): Promise<void> {
  if (!hasWasmGrammar(language)) return;
  await initTreeSitter();
  await loadWasmLanguage(language);
}

/** Parse source with tree-sitter when available; returns empty array on failure. */
export function parseWithTreeSitter(content: string, language: string | null): ExtractedSymbol[] {
  if (!language) return [];

  // WASM path (preferred — 35+ languages)
  if (wasmReady && hasWasmGrammar(language)) {
    const wasmSymbols = parseWithWasm(content, language);
    if (wasmSymbols.length > 0) return wasmSymbols;
  }

  // Native path (fast fallback for bundled grammars)
  const nativeSymbols = parseWithNative(content, language);
  if (nativeSymbols.length > 0) return nativeSymbols;

  return [];
}

export function isTreeSitterAvailable(language: string | null): boolean {
  if (!language) return false;
  if (hasWasmGrammar(language) && wasmReady) return wasmLanguageCache.get(language) !== null;
  if (NATIVE_PACKAGES[language]) {
    return loadNativeParser() !== null && loadNativeLanguage(language) !== null;
  }
  return false;
}

export function getTreeSitterQuery(language: string): string | undefined {
  return getTagQuery(language);
}

/** Warm up common WASM grammars after init. */
export async function preloadCommonLanguages(): Promise<void> {
  const ready = await initTreeSitter();
  if (!ready) return;
  const common = ['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'ruby', 'php', 'c', 'cpp'];
  await Promise.all(common.map((lang) => loadWasmLanguage(lang)));
}
