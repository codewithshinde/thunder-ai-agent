import type { CommitMessageInput } from './commitMessageTypes';

export function buildCommitMessagePrompt(input: CommitMessageInput): string {
  return [
    'Generate one safe Git commit message for the staged changes.',
    '',
    'Rules:',
    '- Use Conventional Commits when appropriate, e.g. feat(ask):, fix:, chore:, test:.',
    '- Subject must be 72 characters or fewer.',
    '- Focus on what changed and why, not a file-by-file list.',
    '- If a short body is useful, use 1-2 concise bullet-free sentences after a blank line.',
    '- Never include secrets, tokens, private keys, or raw .env values.',
    '- Return only the commit message, no markdown fences or commentary.',
    '',
    `Branch: ${input.branch || '(unknown)'}`,
    `Scope hint: ${input.scope || '(infer from files)'}`,
    '',
    'Recent commit style:',
    input.recentCommits.length ? input.recentCommits.join('\n') : '(none)',
    '',
    'Changed files:',
    input.changedFiles.length ? input.changedFiles.join('\n') : '(none)',
    '',
    'Staged diff:',
    redactSensitiveDiff(input.stagedDiff || '(no staged diff)'),
    '',
    input.unstagedDiff
      ? `Unstaged diff summary for awareness only; do not describe it as committed:\n${redactSensitiveDiff(input.unstagedDiff)}`
      : 'Unstaged diff: (none)',
  ].join('\n');
}

export function redactSensitiveDiff(diff: string): string {
  return diff
    .split(/\r?\n/)
    .map((line) => {
      if (/(api[_-]?key|token|secret|password|private[_-]?key|authorization)\s*[:=]/i.test(line)) {
        const prefix = line.match(/^[-+\s]*/)?.[0] ?? '';
        return `${prefix}[redacted sensitive line]`;
      }
      if (/\.env(?:\.|$|\/)/i.test(line) && /^[+-]/.test(line)) {
        return `${line[0]}[redacted .env line]`;
      }
      return line;
    })
    .join('\n')
    .slice(0, 24_000);
}
