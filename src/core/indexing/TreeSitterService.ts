import type { ExtractedSymbol } from './SymbolExtractor';

type TreeSitterModule = {
  Parser: new () => {
    setLanguage(lang: unknown): void;
    parse(content: string): { rootNode: { children: unknown[] } };
  };
};

type LanguageModule = { default?: unknown; [key: string]: unknown };

const LANGUAGE_PACKAGES: Record<string, string> = {
  typescript: 'tree-sitter-typescript',
  javascript: 'tree-sitter-javascript',
  python: 'tree-sitter-python',
  go: 'tree-sitter-go',
  java: 'tree-sitter-java',
};

const QUERY_BY_LANGUAGE: Record<string, string> = {
  typescript: `
    (class_declaration name: (type_identifier) @name) @def
    (interface_declaration name: (type_identifier) @name) @def
    (function_declaration name: (identifier) @name) @def
    (method_definition name: (property_identifier) @name) @def
    (lexical_declaration (variable_declarator name: (identifier) @name)) @def
    (type_alias_declaration name: (type_identifier) @name) @def
    (enum_declaration name: (identifier) @name) @def
  `,
  javascript: `
    (class_declaration name: (identifier) @name) @def
    (function_declaration name: (identifier) @name) @def
    (method_definition name: (property_identifier) @name) @def
    (lexical_declaration (variable_declarator name: (identifier) @name)) @def
  `,
  python: `
    (class_definition name: (identifier) @name) @def
    (function_definition name: (identifier) @name) @def
  `,
  go: `
    (function_declaration name: (identifier) @name) @def
    (method_declaration name: (field_identifier) @name) @def
    (type_declaration (type_spec name: (type_identifier) @name)) @def
  `,
};

interface ParsedNode {
  type?: string;
  startPosition?: { row: number };
  endPosition?: { row: number };
  text?: string;
  namedChild?: (name: string) => ParsedNode | null;
  namedChildren?: ParsedNode[];
  childCount?: number;
  child?: (i: number) => ParsedNode | null;
}

let parserInstance: InstanceType<TreeSitterModule['Parser']> | null = null;
let parserInitFailed = false;
const languageCache = new Map<string, unknown>();

function loadParser(): InstanceType<TreeSitterModule['Parser']> | null {
  if (parserInitFailed) return null;
  if (parserInstance) return parserInstance;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const TreeSitter = require('tree-sitter') as TreeSitterModule;
    parserInstance = new TreeSitter.Parser();
    return parserInstance;
  } catch {
    parserInitFailed = true;
    return null;
  }
}

function loadLanguage(language: string): unknown | null {
  if (languageCache.has(language)) return languageCache.get(language) ?? null;

  const pkg = LANGUAGE_PACKAGES[language];
  if (!pkg) return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(pkg) as LanguageModule;
    const lang =
      mod.typescript ??
      mod.javascript ??
      mod.python ??
      mod.go ??
      mod.java ??
      mod.default ??
      mod;
    languageCache.set(language, lang);
    return lang;
  } catch {
    languageCache.set(language, null);
    return null;
  }
}

function nodeName(node: ParsedNode): string | null {
  const typeId = node.namedChild?.('name') ?? node.namedChild?.('type_identifier') ?? node.namedChild?.('identifier');
  return typeId?.text?.trim() ?? null;
}

function nodeKind(nodeType: string): string {
  if (nodeType.includes('class')) return 'class';
  if (nodeType.includes('interface')) return 'interface';
  if (nodeType.includes('method')) return 'method';
  if (nodeType.includes('function')) return 'function';
  if (nodeType.includes('enum')) return 'enum';
  if (nodeType.includes('type_alias') || nodeType.includes('type_spec')) return 'type';
  if (nodeType.includes('variable') || nodeType.includes('declarator')) return 'const';
  return 'symbol';
}

function walkDefinitions(node: ParsedNode, symbols: ExtractedSymbol[], depth = 0): void {
  if (depth > 40) return;
  const type = node.type ?? '';

  const definitionTypes = [
    'class_declaration',
    'interface_declaration',
    'function_declaration',
    'method_definition',
    'type_alias_declaration',
    'enum_declaration',
    'lexical_declaration',
    'function_definition',
    'class_definition',
    'type_declaration',
  ];

  if (definitionTypes.some((t) => type.includes(t))) {
    const name = nodeName(node);
    if (name && name.length > 1 && !/^(default|exports?)$/.test(name)) {
      const startLine = (node.startPosition?.row ?? 0) + 1;
      const endLine = node.endPosition ? node.endPosition.row + 1 : null;
      if (!symbols.some((s) => s.name === name && s.startLine === startLine)) {
        symbols.push({
          name,
          kind: nodeKind(type),
          signature: null,
          startLine,
          endLine,
        });
      }
    }
  }

  const count = node.childCount ?? node.namedChildren?.length ?? 0;
  for (let i = 0; i < count; i++) {
    const child = node.child?.(i) ?? node.namedChildren?.[i];
    if (child) walkDefinitions(child, symbols, depth + 1);
  }
}

/** Parse source with tree-sitter when available; returns empty array on failure. */
export function parseWithTreeSitter(content: string, language: string | null): ExtractedSymbol[] {
  if (!language) return [];

  const parser = loadParser();
  const lang = loadLanguage(language);
  if (!parser || !lang) return [];

  try {
    parser.setLanguage(lang);
    const tree = parser.parse(content) as { rootNode: ParsedNode };
    const symbols: ExtractedSymbol[] = [];
    walkDefinitions(tree.rootNode, symbols);
    return symbols.slice(0, 200);
  } catch {
    return [];
  }
}

export function isTreeSitterAvailable(language: string | null): boolean {
  if (!language || !LANGUAGE_PACKAGES[language]) return false;
  return loadParser() !== null && loadLanguage(language) !== null;
}

export function getTreeSitterQuery(language: string): string | undefined {
  return QUERY_BY_LANGUAGE[language];
}
