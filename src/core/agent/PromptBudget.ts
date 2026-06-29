import type { ChatMessage, ChatRequest } from '../llm/types';
import { estimateChatRequestTokens } from '../llm/UsageTrackingProvider';
import { compactMessages } from './ContextCompaction';

/** Reserve headroom so the model can still produce a reply. */
export const OUTPUT_RESERVE_RATIO = 0.15;

export function getMaxInputTokens(contextWindow: number): number {
  return Math.floor(contextWindow * (1 - OUTPUT_RESERVE_RATIO));
}

export interface FitChatRequestResult {
  request: ChatRequest;
  trimmed: boolean;
  beforeTokens: number;
  afterTokens: number;
}

/**
 * Hard-cap a chat request to the configured context window by progressively
 * trimming older tool output, compacting transcript, then shrinking codebase context.
 */
export function fitChatRequestToBudget(
  request: ChatRequest,
  maxInputTokens: number
): FitChatRequestResult {
  const beforeTokens = estimateChatRequestTokens(request);
  if (beforeTokens <= maxInputTokens) {
    return { request, trimmed: false, beforeTokens, afterTokens: beforeTokens };
  }

  let messages = [...request.messages];
  let trimmed = false;

  messages = truncateOlderToolOutputs(messages);
  trimmed = true;
  let afterTokens = estimateChatRequestTokens({ ...request, messages });
  if (afterTokens <= maxInputTokens) {
    return { request: { ...request, messages }, trimmed, beforeTokens, afterTokens };
  }

  messages = compactTranscriptAroundUser(messages, request.tools, maxInputTokens);
  afterTokens = estimateChatRequestTokens({ ...request, messages });
  if (afterTokens <= maxInputTokens) {
    return { request: { ...request, messages }, trimmed, beforeTokens, afterTokens };
  }

  messages = shrinkCodebaseContext(messages, request.tools, maxInputTokens);
  afterTokens = estimateChatRequestTokens({ ...request, messages });
  if (afterTokens <= maxInputTokens) {
    return { request: { ...request, messages }, trimmed, beforeTokens, afterTokens };
  }

  messages = hardTruncateTail(messages, request.tools, maxInputTokens);
  afterTokens = estimateChatRequestTokens({ ...request, messages });
  return { request: { ...request, messages }, trimmed: true, beforeTokens, afterTokens };
}

function truncateOlderToolOutputs(messages: ChatMessage[]): ChatMessage[] {
  const toolIndices = messages
    .map((message, index) => (message.role === 'tool' ? index : -1))
    .filter((index) => index >= 0);
  if (toolIndices.length <= 4) return messages;

  const keepFull = new Set(toolIndices.slice(-4));
  return messages.map((message, index) => {
    if (message.role !== 'tool' || keepFull.has(index)) return message;
    const content = message.content ?? '';
    if (content.length <= 600) return message;
    return {
      ...message,
      content: `${content.slice(0, 600)}\n…[truncated for context budget]`,
    };
  });
}

function compactTranscriptAroundUser(
  messages: ChatMessage[],
  tools: ChatRequest['tools'],
  maxInputTokens: number
): ChatMessage[] {
  const systemMessages = messages.filter((message) => message.role === 'system');
  const lastUserIndex = findLastIndex(messages, (message) => message.role === 'user');
  if (lastUserIndex < 0) return messages;

  const lastUser = messages[lastUserIndex];
  const middle = messages.filter((_, index) => index !== lastUserIndex && messages[index].role !== 'system');
  const anchorTokens = estimateChatRequestTokens({
    messages: [...systemMessages, lastUser],
    tools,
  });
  const middleBudget = maxInputTokens - anchorTokens;
  if (middleBudget < 120 || middle.length === 0) return messages;

  const compacted = compactMessages(middle, middleBudget);
  return [...systemMessages, ...compacted, lastUser];
}

function shrinkCodebaseContext(
  messages: ChatMessage[],
  tools: ChatRequest['tools'],
  maxInputTokens: number
): ChatMessage[] {
  const lastUserIndex = findLastIndex(messages, (message) => message.role === 'user');
  if (lastUserIndex < 0) return messages;

  const lastUser = messages[lastUserIndex];
  const marker = '## Codebase Context';
  const markerIndex = lastUser.content.indexOf(marker);
  if (markerIndex < 0) return messages;

  const prefix = lastUser.content.slice(0, markerIndex + marker.length);
  const suffixStart = lastUser.content.indexOf('\n---\n\n## User request');
  const suffix = suffixStart >= 0 ? lastUser.content.slice(suffixStart) : '';
  const otherMessages = messages.filter((_, index) => index !== lastUserIndex);
  const overhead = estimateChatRequestTokens({ messages: otherMessages, tools });
  const contextBudget = Math.max(200, maxInputTokens - overhead - estimateTokensForText(suffix) - 32);
  const contextBody = lastUser.content.slice(markerIndex + marker.length, suffixStart >= 0 ? suffixStart : undefined);
  const shrunkBody = truncateToTokenBudget(contextBody, contextBudget);
  const nextUser = {
    ...lastUser,
    content: `${prefix}\n\n${shrunkBody}${suffix}`,
  };
  return messages.map((message, index) => (index === lastUserIndex ? nextUser : message));
}

function hardTruncateTail(
  messages: ChatMessage[],
  tools: ChatRequest['tools'],
  maxInputTokens: number
): ChatMessage[] {
  const fitted = [...messages];
  while (fitted.length > 2 && estimateChatRequestTokens({ messages: fitted, tools }) > maxInputTokens) {
    const removable = fitted.findIndex(
      (message, index) => message.role !== 'system' && index < fitted.length - 1
    );
    if (removable < 0) break;
    fitted.splice(removable, 1);
  }

  const lastUserIndex = findLastIndex(fitted, (message) => message.role === 'user');
  if (lastUserIndex < 0) return fitted;

  const overhead = estimateChatRequestTokens({
    messages: fitted.filter((_, index) => index !== lastUserIndex),
    tools,
  });
  const userBudget = Math.max(120, maxInputTokens - overhead);
  const user = fitted[lastUserIndex];
  fitted[lastUserIndex] = {
    ...user,
    content: truncateToTokenBudget(user.content, userBudget),
  };
  return fitted;
}

function truncateToTokenBudget(text: string, tokenBudget: number): string {
  const maxChars = Math.max(1, tokenBudget * 4);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated for context budget]`;
}

function estimateTokensForText(text: string): number {
  return Math.ceil(text.length / 4);
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}
