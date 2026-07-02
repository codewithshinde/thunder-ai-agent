import type { ReleaseMarkdownInput } from './ChangelogGenerator';

export function generateReleaseNotes(input: ReleaseMarkdownInput): string {
  const highlights = input.commits.filter((c) => c.type === 'feat' || c.breaking).slice(0, 5);
  const fixes = input.commits.filter((c) => c.type === 'fix').slice(0, 6);
  const lines = [`# Mitii ${input.version} Release Notes`, ''];

  if (highlights.length > 0) {
    lines.push('## Highlights');
    for (const commit of highlights) {
      lines.push(`- ${commit.description}`);
    }
    lines.push('');
  }

  if (fixes.length > 0) {
    lines.push('## Fixes');
    for (const commit of fixes) {
      lines.push(`- ${commit.description}`);
    }
    lines.push('');
  }

  const breaking = input.commits.filter((c) => c.breaking);
  if (breaking.length > 0) {
    lines.push('## Migration Notes');
    for (const commit of breaking) {
      lines.push(`- ${commit.description}`);
    }
    lines.push('');
  }

  if (input.commits.length === 0) {
    lines.push('No user-facing changes were found for this range.', '');
  }

  return lines.join('\n').trimEnd() + '\n';
}

