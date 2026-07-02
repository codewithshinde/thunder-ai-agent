import type { ConventionalCommit } from './GitHistoryCollector';

export interface ReleaseMarkdownInput {
  commits: ConventionalCommit[];
  version: string;
  date: Date;
}

export function generateChangelogEntry(input: ReleaseMarkdownInput): string {
  const date = formatDate(input.date);
  const groups = groupCommits(input.commits);
  const lines = [`## [${input.version}] - ${date}`, ''];

  appendSection(lines, 'Breaking', groups.breaking);
  appendSection(lines, 'Added', groups.added);
  appendSection(lines, 'Fixed', groups.fixed);
  appendSection(lines, 'Changed', groups.changed);

  if (input.commits.length === 0) {
    lines.push('No commits found since the selected tag.', '');
  }
  return lines.join('\n').trimEnd() + '\n';
}

export function insertChangelogEntry(existing: string, entry: string): string {
  const normalized = existing.trim() || '# Changelog\n\n## [Unreleased]\n';
  if (/## \[Unreleased\]/.test(normalized)) {
    return normalized.replace(/(## \[Unreleased\][^\n]*)/, `$1\n\n${entry.trimEnd()}`).trimEnd() + '\n';
  }
  return `${normalized}\n\n## [Unreleased]\n\n${entry}`.trimEnd() + '\n';
}

function groupCommits(commits: ConventionalCommit[]) {
  return {
    breaking: commits.filter((c) => c.breaking),
    added: commits.filter((c) => c.type === 'feat' && !c.breaking),
    fixed: commits.filter((c) => c.type === 'fix' && !c.breaking),
    changed: commits.filter((c) => !c.breaking && c.type !== 'feat' && c.type !== 'fix'),
  };
}

function appendSection(lines: string[], title: string, commits: ConventionalCommit[]): void {
  if (commits.length === 0) return;
  lines.push(`### ${title}`);
  for (const commit of commits) {
    const scope = commit.scope ? `**${commit.scope}:** ` : '';
    const hash = commit.hash ? ` (${commit.hash})` : '';
    lines.push(`- ${scope}${commit.description}${hash}`);
  }
  lines.push('');
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
