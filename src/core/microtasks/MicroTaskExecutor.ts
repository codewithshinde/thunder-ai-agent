import { readFileSync } from 'fs';
import { join } from 'path';
import type { LlmProvider } from '../llm/types';
import type { SessionLogService } from '../telemetry/SessionLogService';
import { collectCommitMessageInput, generateCommitMessage, buildCommitMessagePrompt } from '../scm';
import { estimateChatRequestTokens } from '../llm/UsageTrackingProvider';
import type { GitService } from '../context/GitService';
import { GitHistoryCollector } from '../release/GitHistoryCollector';
import { generateChangelogEntry } from '../release/ChangelogGenerator';
import { generateReleaseNotes } from '../release/ReleaseNotesGenerator';
import type { MicroTaskId, MicroTaskResult } from './types';

export interface MicroTaskExecutorDeps {
  workspace: string;
  git: GitService;
  provider?: LlmProvider;
  sessionLog?: SessionLogService;
}

export class MicroTaskExecutor {
  constructor(private readonly deps: MicroTaskExecutorDeps) {}

  async execute(id: MicroTaskId, userMessage: string): Promise<MicroTaskResult> {
    if (id === 'commit_message') return this.generateCommitMessage(userMessage);
    if (id === 'release_notes_draft') return this.generateReleaseNotes(userMessage);
    return this.generateChangelogEntry(userMessage);
  }

  private async generateCommitMessage(_userMessage: string): Promise<MicroTaskResult> {
    if (!this.deps.provider) {
      throw new Error('No LLM provider configured for commit message generation.');
    }
    if (!this.deps.git.isGitRepo) {
      throw new Error('No Git repository found for this workspace.');
    }
    const input = await collectCommitMessageInput(this.deps.git, {
      stagedDiffMaxChars: 12_000,
      unstagedDiffMaxChars: 4_000,
      perFileMaxChars: 2_000,
    });
    if (!input.stagedDiff.trim() && input.unstagedDiff?.trim()) {
      throw new Error('Only unstaged changes found. Stage files before generating a commit message.');
    }
    const prompt = buildCommitMessagePrompt(input);
    this.logContext('commit_message', prompt, {
      changedFiles: input.changedFiles.length,
      hasUnstagedDiff: Boolean(input.unstagedDiff?.trim()),
    });
    const result = await generateCommitMessage(input, this.deps.provider);
    return {
      id: 'commit_message',
      content: result.fullMessage,
      metadata: {
        subject: result.subject,
        promptTokens: estimateChatRequestTokens({
          messages: [
            { role: 'system', content: 'commit' },
            { role: 'user', content: prompt },
          ],
        }),
      },
    };
  }

  private async generateChangelogEntry(userMessage: string): Promise<MicroTaskResult> {
    const collector = new GitHistoryCollector(this.deps.workspace);
    const latestTag = await collector.getLatestTag();
    const commits = await collector.getCommitsSinceTag(extractSinceRef(userMessage) ?? latestTag ?? undefined);
    const version = readPackageVersion(this.deps.workspace);
    const content = generateChangelogEntry({ commits, version, date: new Date() });
    this.logContext('changelog_entry', JSON.stringify(commits), {
      latestTag,
      commitCount: commits.length,
      version,
    });
    return { id: 'changelog_entry', content, metadata: { latestTag, commitCount: commits.length, version } };
  }

  private async generateReleaseNotes(userMessage: string): Promise<MicroTaskResult> {
    const collector = new GitHistoryCollector(this.deps.workspace);
    const latestTag = await collector.getLatestTag();
    const commits = await collector.getCommitsSinceTag(extractSinceRef(userMessage) ?? latestTag ?? undefined);
    const version = readPackageVersion(this.deps.workspace);
    const content = generateReleaseNotes({ commits, version, date: new Date() });
    this.logContext('release_notes_draft', JSON.stringify(commits), {
      latestTag,
      commitCount: commits.length,
      version,
    });
    return { id: 'release_notes_draft', content, metadata: { latestTag, commitCount: commits.length, version } };
  }

  private logContext(id: MicroTaskId, context: string, data: Record<string, unknown>): void {
    this.deps.sessionLog?.append('microtask_context', `Micro-task context: ${id}`, {
      id,
      contextChars: context.length,
      estimatedTokens: Math.ceil(context.length / 4),
      ...data,
    });
  }
}

function extractSinceRef(message: string): string | undefined {
  const match = message.match(/\b(?:since|from)\s+([A-Za-z0-9._/-]+)/i);
  return match?.[1];
}

function readPackageVersion(workspace: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
