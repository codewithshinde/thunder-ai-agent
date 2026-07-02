import { describe, expect, it } from 'vitest';
import { generateChangelogEntry, insertChangelogEntry } from '../src/core/release/ChangelogGenerator';
import { generateReleaseNotes } from '../src/core/release/ReleaseNotesGenerator';
import { parseConventionalSubject } from '../src/core/release/GitHistoryCollector';

describe('release automation', () => {
  const commits = [
    { hash: 'aaa111', subject: 'feat(ui): stream reasoning', type: 'feat', scope: 'ui', description: 'stream reasoning', breaking: false },
    { hash: 'bbb222', subject: 'fix: redact token', type: 'fix', description: 'redact token', breaking: false },
    { hash: 'ccc333', subject: 'feat!: change api', type: 'feat', description: 'change api', breaking: true },
  ];

  it('groups conventional commits into changelog sections', () => {
    const out = generateChangelogEntry({ commits, version: '1.2.3', date: new Date('2026-07-02T00:00:00Z') });
    expect(out).toContain('## [1.2.3] - 2026-07-02');
    expect(out).toContain('### Breaking');
    expect(out).toContain('### Added');
    expect(out).toContain('**ui:** stream reasoning');
    expect(out).toContain('### Fixed');
  });

  it('detects breaking changes from subject and body', () => {
    expect(parseConventionalSubject('feat!: replace config').breaking).toBe(true);
    expect(parseConventionalSubject('feat: replace config', 'BREAKING CHANGE: config moved').breaking).toBe(true);
  });

  it('inserts entries after Unreleased', () => {
    const out = insertChangelogEntry('# Changelog\n\n## [Unreleased]\n', '## [1.0.0] - 2026-07-02\n');
    expect(out).toMatch(/## \[Unreleased\]\n\n## \[1\.0\.0\]/);
  });

  it('generates empty release-note fallback', () => {
    expect(generateReleaseNotes({ commits: [], version: '1.0.0', date: new Date() })).toContain('No user-facing changes');
  });
});

