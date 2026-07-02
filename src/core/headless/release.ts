import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { GitHistoryCollector, generateChangelogEntry, generateReleaseNotes, insertChangelogEntry } from '../release';

export interface PrepareReleaseResult {
  changelogEntry: string;
  releaseNotes: string;
  changelogPath: string;
  releaseNotesPath: string;
}

export async function generateHeadlessChangelog(cwd: string, since?: string): Promise<string> {
  const collector = new GitHistoryCollector(cwd);
  const tag = since ?? await collector.getLatestTag() ?? undefined;
  const commits = await collector.getCommitsSinceTag(tag);
  return generateChangelogEntry({ commits, version: readPackageVersion(cwd), date: new Date() });
}

export async function prepareHeadlessRelease(cwd: string, since?: string): Promise<PrepareReleaseResult> {
  const collector = new GitHistoryCollector(cwd);
  const tag = since ?? await collector.getLatestTag() ?? undefined;
  const commits = await collector.getCommitsSinceTag(tag);
  const version = readPackageVersion(cwd);
  const changelogEntry = generateChangelogEntry({ commits, version, date: new Date() });
  const releaseNotes = generateReleaseNotes({ commits, version, date: new Date() });
  const changelogPath = join(cwd, 'CHANGELOG.md');
  const existing = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '# Changelog\n\n## [Unreleased]\n';
  writeFileSync(changelogPath, insertChangelogEntry(existing, changelogEntry), 'utf8');
  const releaseNotesPath = join(cwd, '.mitii', 'release-notes.md');
  mkdirSync(dirname(releaseNotesPath), { recursive: true });
  writeFileSync(releaseNotesPath, releaseNotes, 'utf8');
  return { changelogEntry, releaseNotes, changelogPath, releaseNotesPath };
}

function readPackageVersion(cwd: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

