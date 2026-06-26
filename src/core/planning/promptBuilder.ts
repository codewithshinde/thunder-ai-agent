import type { ContextPack } from '../context/types';
import type { ChatMessage } from '../llm/types';
import type { ThunderMode } from '../ThunderSession';

export function buildSystemPrompt(mode: ThunderMode): string {
  const modeInstructions: Record<ThunderMode, string> = {
    plan: 'You are in PLAN mode. Analyze, propose steps, and ask clarifying questions. Do NOT write files, run shell commands, or apply patches.',
    act: 'You are in ACT mode. You may propose tool use and edits, but all writes and shell commands require user approval.',
    review: 'You are in REVIEW mode. Inspect diffs and test results. Do not make new edits unless explicitly approved.',
  };

  return `You are Thunder, a local-first VS Code coding agent.

${modeInstructions[mode]}

Be precise, concise, and reference specific files when relevant.
Explain your reasoning clearly.`;
}

export function buildPrompt(
  mode: ThunderMode,
  contextPack: ContextPack,
  userMessage: string,
  recentMessages: ChatMessage[] = []
): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(mode) },
  ];

  if (contextPack.formatted) {
    messages.push({
      role: 'system',
      content: `## Context\n\n${contextPack.formatted}`,
    });
  }

  for (const msg of recentMessages.slice(-10)) {
    messages.push(msg);
  }

  messages.push({ role: 'user', content: userMessage });
  return messages;
}
