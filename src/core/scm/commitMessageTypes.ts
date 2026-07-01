export interface CommitMessageInput {
  stagedDiff: string;
  unstagedDiff?: string;
  changedFiles: string[];
  recentCommits: string[];
  branch?: string | null;
  scope?: string;
}

export interface CommitMessageResult {
  subject: string;
  body?: string;
  fullMessage: string;
}
