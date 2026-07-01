import type { GitService } from '../context/GitService';
import type { CommitMessageInput } from './commitMessageTypes';

export async function collectCommitMessageInput(
  git: GitService,
  options: { scope?: string; stagedDiffMaxChars?: number; unstagedDiffMaxChars?: number } = {}
): Promise<CommitMessageInput> {
  const [stagedDiff, unstagedDiff, changedFiles, recentCommits, branch] = await Promise.all([
    git.getStagedDiff(options.stagedDiffMaxChars ?? 16_000),
    git.getUnstagedDiff(options.unstagedDiffMaxChars ?? 8_000),
    git.getChangedFilesDetailed(),
    git.getRecentCommits(5),
    git.getCurrentBranch(),
  ]);

  return {
    stagedDiff,
    unstagedDiff,
    changedFiles,
    recentCommits,
    branch,
    scope: options.scope,
  };
}
