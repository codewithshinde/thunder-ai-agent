import type { GitService } from '../context/GitService';
import type { CommitMessageInput } from './commitMessageTypes';

export async function collectCommitMessageInput(
  git: GitService,
  options: {
    scope?: string;
    stagedDiffMaxChars?: number;
    unstagedDiffMaxChars?: number;
    perFileMaxChars?: number;
  } = {}
): Promise<CommitMessageInput> {
  const [stagedDiff, unstagedDiff, changedFiles, recentCommits, branch] = await Promise.all([
    git.getStagedDiff(options.stagedDiffMaxChars ?? 16_000),
    git.getUnstagedDiff(options.unstagedDiffMaxChars ?? 8_000),
    git.getChangedFilesDetailed(),
    git.getRecentCommits(5),
    git.getCurrentBranch(),
  ]);

  return {
    stagedDiff: budgetDiff(stagedDiff, {
      totalMaxChars: options.stagedDiffMaxChars ?? 16_000,
      perFileMaxChars: options.perFileMaxChars,
    }),
    unstagedDiff: budgetDiff(unstagedDiff, {
      totalMaxChars: options.unstagedDiffMaxChars ?? 8_000,
      perFileMaxChars: options.perFileMaxChars,
    }),
    changedFiles,
    recentCommits,
    branch,
    scope: options.scope,
  };
}

export function budgetDiff(
  diff: string,
  options: { totalMaxChars: number; perFileMaxChars?: number }
): string {
  if (!diff || diff.length <= options.totalMaxChars && !options.perFileMaxChars) {
    return diff;
  }

  const perFileMax = options.perFileMaxChars ?? options.totalMaxChars;
  const files = diff.split(/(?=^diff --git )/m).filter(Boolean);
  const budgeted = files.map((fileDiff) => {
    if (fileDiff.length <= perFileMax) return fileDiff;
    const header = fileDiff
      .split(/\r?\n/)
      .filter((line) => /^(diff --git|index |--- |\+\+\+ |@@ )/.test(line))
      .join('\n');
    return `${header}\n[diff truncated: ${fileDiff.length - header.length} chars omitted]\n`;
  }).join('');

  if (budgeted.length <= options.totalMaxChars) return budgeted;
  return `${budgeted.slice(0, options.totalMaxChars)}\n[diff truncated: ${budgeted.length - options.totalMaxChars} chars omitted]\n`;
}
