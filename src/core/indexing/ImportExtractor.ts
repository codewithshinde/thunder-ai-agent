import { dirname, extname, join, normalize } from 'path';

export interface ExtractedImport {
  specifier: string;
  line: number;
}

const IMPORT_PATTERNS = [
  /^\s*import\s+(?:type\s+)?(?:[\w*{}\s,]+)\s+from\s+['"]([^'"]+)['"]/,
  /^\s*import\s+['"]([^'"]+)['"]/,
  /^\s*export\s+(?:type\s+)?(?:[\w*{}\s,]+)\s+from\s+['"]([^'"]+)['"]/,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/,
  /^\s*from\s+['"]([^'"]+)['"]\s+import/,
];

/** Extract raw import specifiers from source text. */
export function extractImports(content: string): ExtractedImport[] {
  const lines = content.split('\n');
  const imports: ExtractedImport[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of IMPORT_PATTERNS) {
      const match = line.match(pattern);
      if (match?.[1] && !seen.has(`${i}:${match[1]}`)) {
        seen.add(`${i}:${match[1]}`);
        imports.push({ specifier: match[1], line: i + 1 });
      }
    }
  }

  return imports;
}

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '/index.ts', '/index.tsx', '/index.js'];

/** Resolve a relative import specifier to a workspace-relative path. */
export function resolveImportTarget(fromRelPath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;

  const baseDir = dirname(fromRelPath);
  let resolved = normalize(join(baseDir, specifier)).replace(/\\/g, '/');
  if (resolved.startsWith('../')) return null;

  const ext = extname(resolved);
  if (ext) return resolved;

  for (const suffix of RESOLVE_EXTENSIONS) {
    const candidate = resolved + suffix;
    if (!candidate.includes('..')) return candidate;
  }

  return resolved;
}
