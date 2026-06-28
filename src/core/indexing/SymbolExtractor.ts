import { parseWithTreeSitter } from './TreeSitterService';
import { getRegexPatterns } from './languageRegistry';

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

function extractWithPatterns(
  content: string,
  patterns: Array<{ regex: RegExp; kind: string }>
): ExtractedSymbol[] {
  const lines = content.split('\n');
  const symbols: ExtractedSymbol[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { regex, kind } of patterns) {
      const match = line.match(regex);
      if (match) {
        const name = match[1] ?? match[0];
        if (name.length > 1) {
          symbols.push({
            name,
            kind,
            signature: line.trim().slice(0, 120),
            startLine: i + 1,
            endLine: null,
          });
        }
      }
    }
  }
  return symbols;
}

function dedupeSymbols(symbols: ExtractedSymbol[]): ExtractedSymbol[] {
  const seen = new Set<string>();
  return symbols.filter((s) => {
    const key = `${s.kind}:${s.name}:${s.startLine}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Universal symbol extractor: tree-sitter first, regex fallback for 100+ languages. */
export function extractSymbols(content: string, language: string | null): ExtractedSymbol[] {
  if (!language) return [];

  const treeSitterSymbols = parseWithTreeSitter(content, language);
  if (treeSitterSymbols.length > 0) return dedupeSymbols(treeSitterSymbols);

  const patterns = getRegexPatterns(language);
  if (patterns.length > 0) return dedupeSymbols(extractWithPatterns(content, patterns));

  return [];
}

// Legacy per-language extractors (delegate to universal extractor)
export const tsExtractor: SymbolExtractor = {
  language: 'typescript',
  extract: (content) => extractSymbols(content, 'typescript'),
};

export const jsExtractor: SymbolExtractor = {
  language: 'javascript',
  extract: (content) => extractSymbols(content, 'javascript'),
};

export const pythonExtractor: SymbolExtractor = {
  language: 'python',
  extract: (content) => extractSymbols(content, 'python'),
};

export const javaExtractor: SymbolExtractor = {
  language: 'java',
  extract: (content) => extractSymbols(content, 'java'),
};

export const goExtractor: SymbolExtractor = {
  language: 'go',
  extract: (content) => extractSymbols(content, 'go'),
};

const EXTRACTORS: Record<string, SymbolExtractor> = {
  typescript: tsExtractor,
  javascript: jsExtractor,
  python: pythonExtractor,
  java: javaExtractor,
  go: goExtractor,
};

export function getExtractor(language: string | null): SymbolExtractor | undefined {
  if (!language) return undefined;
  // Return a dynamic extractor for any registered language
  if (language in EXTRACTORS) return EXTRACTORS[language];
  return {
    language,
    extract: (content) => extractSymbols(content, language),
  };
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

export interface TreeSitterParser {
  parse(content: string, language: string): ExtractedSymbol[];
}

export const treeSitterParser: TreeSitterParser = {
  parse: (content, language) => extractSymbols(content, language),
};
