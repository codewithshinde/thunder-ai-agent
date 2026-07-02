import simpleGit, { type SimpleGit } from 'simple-git';

export interface ConventionalCommit {
  hash: string;
  subject: string;
  type: string;
  scope?: string;
  description: string;
  breaking: boolean;
  body?: string;
}

export class GitHistoryCollector {
  private readonly git: SimpleGit;

  constructor(workspace: string) {
    this.git = simpleGit(workspace);
  }

  async getTags(): Promise<string[]> {
    try {
      const tags = await this.git.tags();
      return tags.all;
    } catch {
      return [];
    }
  }

  async getLatestTag(): Promise<string | null> {
    try {
      const tag = await this.git.raw(['describe', '--tags', '--abbrev=0']);
      return tag.trim() || null;
    } catch {
      return null;
    }
  }

  async getCommitsSinceTag(tag?: string): Promise<ConventionalCommit[]> {
    try {
      const range = tag ? `${tag}..HEAD` : 'HEAD';
      const raw = await this.git.raw([
        'log',
        range,
        '--pretty=format:%H%x1f%s%x1f%b%x1e',
      ]);
      return raw
        .split('\x1e')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map(parseCommitRecord);
    } catch {
      return [];
    }
  }
}

export function parseCommitRecord(record: string): ConventionalCommit {
  const [hash = '', subject = '', body = ''] = record.split('\x1f');
  const parsed = parseConventionalSubject(subject, body);
  return {
    hash: hash.slice(0, 12),
    subject,
    body: body.trim() || undefined,
    ...parsed,
  };
}

export function parseConventionalSubject(subject: string, body = ''): Omit<ConventionalCommit, 'hash' | 'subject' | 'body'> {
  const match = subject.match(/^([a-z]+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/i);
  const breaking = Boolean(match?.[3]) || /\bBREAKING CHANGE:/i.test(body);
  if (!match) {
    return { type: 'other', description: subject.trim(), breaking };
  }
  return {
    type: match[1].toLowerCase(),
    scope: match[2],
    description: match[4].trim(),
    breaking,
  };
}
