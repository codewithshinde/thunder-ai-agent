import type { LlmProvider } from '../llm/types';
import { buildCommitMessagePrompt } from './commitMessagePrompt';
import type { CommitMessageInput, CommitMessageResult } from './commitMessageTypes';

export async function generateCommitMessage(
  input: CommitMessageInput,
  provider: LlmProvider
): Promise<CommitMessageResult> {
  validateCommitMessageInput(input);
  let text = '';
  for await (const delta of provider.complete({
    messages: [
      {
        role: 'system',
        content: 'You write concise, accurate Git commit messages for a coding agent. Return only the message.',
      },
      { role: 'user', content: buildCommitMessagePrompt(input) },
    ],
    stream: true,
    toolChoice: 'none',
    maxTokens: 240,
  })) {
    if (delta.error) throw new Error(delta.error);
    if (delta.content) text += delta.content;
    if (delta.done) break;
  }

  return normalizeCommitMessage(text);
}

export function normalizeCommitMessage(raw: string): CommitMessageResult {
  const cleaned = raw
    .replace(/^```(?:gitcommit|text)?/i, '')
    .replace(/```$/i, '')
    .trim();
  const lines = cleaned.split(/\r?\n/).map((line) => line.trimEnd());
  const subject = truncateSubject((lines.find((line) => line.trim()) ?? 'chore: update workspace').trim());
  const bodyLines = lines.slice(lines.findIndex((line) => line.trim()) + 1).join('\n').trim();
  const body = bodyLines || undefined;
  return {
    subject,
    body,
    fullMessage: body ? `${subject}\n\n${body}` : subject,
  };
}

function validateCommitMessageInput(input: CommitMessageInput): void {
  if (!input.stagedDiff.trim()) {
    throw new Error('No staged changes found. Stage files before generating a commit message.');
  }
}

function truncateSubject(subject: string): string {
  if (subject.length <= 72) return subject;
  return `${subject.slice(0, 69).replace(/\s+\S*$/, '')}...`;
}
