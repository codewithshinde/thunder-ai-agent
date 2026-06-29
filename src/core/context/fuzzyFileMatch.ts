const FILE_MENTION_PATTERN =
  /\b[\w./-]+\.(tsx?|jsx?|vue|svelte|py|go|rs|java|kt|swift|md|json|css|scss|html|yaml|yml|toml)\b/gi;
const PACKAGE_LIKE_PATTERN = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/gi;

export function extractFileMentions(text: string): string[] {
  const matches = text.match(FILE_MENTION_PATTERN) ?? [];
  return [...new Set(matches.map((m) => m.replace(/^\.\//, '')))];
}

export function extractComponentNames(text: string): string[] {
  // Only derive component/file stems from explicit file paths — not arbitrary PascalCase words
  // in the user message (e.g. "Identify" must not trigger indexed file search).
  return [...new Set(extractFileMentions(text).map((m) => m.replace(/\.[^.]+$/, '')))];
}

/** Split CamelCase / PascalCase into searchable parts (e.g. DinInKanban → kanban). */
export function expandCamelCaseTerms(name: string): string[] {
  const stem = name.replace(/\.[^.]+$/, '');
  const parts = stem
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s._-]+/)
    .filter((p) => p.length >= 3);

  const terms = new Set<string>([stem.toLowerCase(), ...parts.map((p) => p.toLowerCase())]);
  return [...terms];
}

export function extractIndexedSearchTerms(text: string): string[] {
  const terms = new Set<string>();

  for (const mention of extractFileMentions(text)) {
    for (const term of expandCamelCaseTerms(mention)) {
      terms.add(term);
    }
  }

  for (const component of extractComponentNames(text)) {
    for (const term of expandCamelCaseTerms(component)) {
      terms.add(term);
    }
  }

  for (const packageName of text.match(PACKAGE_LIKE_PATTERN) ?? []) {
    terms.add(packageName.toLowerCase());
  }

  return [...terms].filter((t) => t.length >= 3);
}

export function isProjectOverviewQuestion(text: string): boolean {
  return /\b(what (is|does)|purpose|use of|used for|about this|explain (this )?project|dealing with)\b/i.test(
    text
  );
}

export function globPatternsForMention(mention: string): string[] {
  const normalized = mention.replace(/^\.\//, '');
  const patterns = normalized.includes('/')
    ? [normalized, `**/${normalized}`]
    : [`**/${normalized}`, `**/*/${normalized}`];

  for (const term of expandCamelCaseTerms(normalized)) {
    if (term.length >= 4) {
      patterns.push(`**/*${term}*.tsx`, `**/*${term}*.ts`, `**/*${term}*.jsx`, `**/*${term}*.js`);
    }
  }

  return [...new Set(patterns)];
}
