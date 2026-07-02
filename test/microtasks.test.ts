import { describe, expect, it } from 'vitest';
import { budgetDiff } from '../src/core/scm/GitDiffCollector';
import { buildCommitMessagePrompt, redactSensitiveDiff } from '../src/core/scm/commitMessagePrompt';
import { detectMicroTask, MicroTaskExecutor } from '../src/core/microtasks';
import type { GitService } from '../src/core/context/GitService';
import type { LlmProvider } from '../src/core/llm/types';

describe('microtasks', () => {
  it('detects supported micro-task intents', () => {
    expect(detectMicroTask('write commit message please')).toBe('commit_message');
    expect(detectMicroTask('what changed since v1.2.0')).toBe('changelog_entry');
    expect(detectMicroTask("draft what's new")).toBe('release_notes_draft');
    expect(detectMicroTask('explain the auth flow')).toBeNull();
  });

  it('redacts sensitive diff lines in prompts', () => {
    const prompt = buildCommitMessagePrompt({
      stagedDiff: '+ API_KEY=sk-secret-value',
      unstagedDiff: '',
      changedFiles: ['M src/index.ts'],
      recentCommits: [],
      branch: 'main',
    });
    expect(prompt).toContain('[redacted sensitive line]');
    expect(prompt).not.toContain('sk-secret-value');
  });

  it('budgets large diffs by file and total caps', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      'index 111..222',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      `+${'x'.repeat(5000)}`,
      'diff --git a/b.ts b/b.ts',
      'index 333..444',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '+ok',
    ].join('\n');
    const out = budgetDiff(diff, { totalMaxChars: 1000, perFileMaxChars: 200 });
    expect(out.length).toBeLessThanOrEqual(1100);
    expect(out).toContain('diff truncated');
    expect(out).toContain('diff --git a/b.ts b/b.ts');
  });

  it('runs commit-message micro-task with toolChoice none', async () => {
    const calls: unknown[] = [];
    const provider: LlmProvider = {
      id: 'fake',
      capabilities: { contextWindow: 8192, supportsEmbeddings: false, supportsStreaming: true, supportsTools: true },
      async *complete(request) {
        calls.push(request);
        yield { content: 'feat: add audit pack export' };
        yield { done: true };
      },
    };
    const git = {
      isGitRepo: true,
      getStagedDiff: async () => 'diff --git a/src/a.ts b/src/a.ts\n+export const a = 1;',
      getUnstagedDiff: async () => '',
      getChangedFilesDetailed: async () => ['M src/a.ts'],
      getRecentCommits: async () => ['abc123 feat: old thing'],
      getCurrentBranch: async () => 'main',
    } as unknown as GitService;

    const result = await new MicroTaskExecutor({ workspace: process.cwd(), git, provider }).execute(
      'commit_message',
      'write commit message'
    );

    expect(result.content).toBe('feat: add audit pack export');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ toolChoice: 'none', maxTokens: 240 });
  });

  it('redacts standalone sensitive diff helper output', () => {
    expect(redactSensitiveDiff('+password=abc123')).toBe('+[redacted sensitive line]');
  });
});

