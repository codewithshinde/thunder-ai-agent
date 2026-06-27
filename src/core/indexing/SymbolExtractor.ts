import { parseWithTreeSitter } from './TreeSitterService';

export interface ExtractedSymbol {
  name: string;
  kind: string;
  signature: string | null;
  startLine: number;
  endLine: number | null;
}

export interface SymbolExtractor {
  language: string;
  extract(content: string): ExtractedSymbol[];
}

function extractWithPatterns(content: string, patterns: Array<{ regex: RegExp; kind: string }>): ExtractedSymbol[] {
  const lines = content.split('\n');
  const symbols: ExtractedSymbol[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { regex, kind } of patterns) {
      const match = line.match(regex);
      if (match) {
        symbols.push({
          name: match[1] ?? match[0],
          kind,
          signature: line.trim().slice(0, 120),
          startLine: i + 1,
          endLine: null,
        });
      }
    }
  }
  return symbols;
}

export const tsExtractor: SymbolExtractor = {
  language: 'typescript',
  extract: (content) => {
    const treeSitterSymbols = parseWithTreeSitter(content, 'typescript');
    if (treeSitterSymbols.length > 0) return dedupeSymbols(treeSitterSymbols);
    return extractWithPatterns(content, [
      { regex: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/, kind: 'class' },
      { regex: /^(?:export\s+)?interface\s+(\w+)/, kind: 'interface' },
      { regex: /^(?:export\s+)?(?:async\s+)?function\s+\*?\s*(\w+)/, kind: 'function' },
      { regex: /^(?:export\s+)?type\s+(\w+)/, kind: 'type' },
      { regex: /^(?:export\s+)?enum\s+(\w+)/, kind: 'enum' },
      { regex: /^\s+(?:public|private|protected)?\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::|\{)/, kind: 'method' },
      { regex: /^(?:export\s+)?const\s+(\w+)\s*[=:]/, kind: 'const' },
    ]);
  },
};

export const jsExtractor: SymbolExtractor = {
  language: 'javascript',
  extract: (content) => {
    const treeSitterSymbols = parseWithTreeSitter(content, 'javascript');
    if (treeSitterSymbols.length > 0) return dedupeSymbols(treeSitterSymbols);
    return extractWithPatterns(content, [
      { regex: /^(?:export\s+)?class\s+(\w+)/, kind: 'class' },
      { regex: /^(?:export\s+)?(?:async\s+)?function\s+\*?\s*(\w+)/, kind: 'function' },
      { regex: /^(?:export\s+)?const\s+(\w+)\s*[=:]/, kind: 'const' },
    ]);
  },
};

export const pythonExtractor: SymbolExtractor = {
  language: 'python',
  extract: (content) => {
    const treeSitterSymbols = parseWithTreeSitter(content, 'python');
    if (treeSitterSymbols.length > 0) return dedupeSymbols(treeSitterSymbols);
    return extractWithPatterns(content, [
      { regex: /^class\s+(\w+)/, kind: 'class' },
      { regex: /^(?:async\s+)?def\s+(\w+)/, kind: 'function' },
    ]);
  },
};

export const javaExtractor: SymbolExtractor = {
  language: 'java',
  extract: (content) =>
    extractWithPatterns(content, [
      { regex: /(?:public|private|protected)?\s*(?:static\s+)?class\s+(\w+)/, kind: 'class' },
      { regex: /(?:public|private|protected)\s+\w+[\w<>,\s]*\s+(\w+)\s*\(/, kind: 'method' },
    ]),
};

export const goExtractor: SymbolExtractor = {
  language: 'go',
  extract: (content) => {
    const treeSitterSymbols = parseWithTreeSitter(content, 'go');
    if (treeSitterSymbols.length > 0) return dedupeSymbols(treeSitterSymbols);
    return extractWithPatterns(content, [
      { regex: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/, kind: 'function' },
      { regex: /^type\s+(\w+)\s+struct/, kind: 'struct' },
      { regex: /^type\s+(\w+)\s+interface/, kind: 'interface' },
    ]);
  },
};

function dedupeSymbols(symbols: ExtractedSymbol[]): ExtractedSymbol[] {
  const seen = new Set<string>();
  return symbols.filter((s) => {
    const key = `${s.kind}:${s.name}:${s.startLine}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const EXTRACTORS: Record<string, SymbolExtractor> = {
  typescript: tsExtractor,
  javascript: jsExtractor,
  python: pythonExtractor,
  java: javaExtractor,
  go: goExtractor,
};

export function getExtractor(language: string | null): SymbolExtractor | undefined {
  if (!language) return undefined;
  return EXTRACTORS[language];
}

export function extractSymbolRefs(content: string, knownSymbols: Set<string>): Array<{ name: string; line: number }> {
  const lines = content.split('\n');
  const refs: Array<{ name: string; line: number }> = [];
  const identRegex = /\b([A-Za-z_]\w{2,})\b/g;

  for (let i = 0; i < lines.length; i++) {
    let match;
    while ((match = identRegex.exec(lines[i])) !== null) {
      if (knownSymbols.has(match[1])) {
        refs.push({ name: match[1], line: i + 1 });
      }
    }
  }
  return refs;
}

// Tree-sitter integration — see TreeSitterService.ts
export interface TreeSitterParser {
  parse(content: string, language: string): ExtractedSymbol[];
}

export const treeSitterParser: TreeSitterParser = {
  parse: (content, language) => {
    const tsSymbols = parseWithTreeSitter(content, language);
    if (tsSymbols.length > 0) return tsSymbols;
    return getExtractor(language)?.extract(content) ?? [];
  },
};
