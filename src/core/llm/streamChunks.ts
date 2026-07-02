import type { AssistantStreamChunk } from './types';

export function chunkContent(chunk: AssistantStreamChunk): string {
  return typeof chunk === 'string' ? chunk : (chunk.content ?? '');
}

export function chunkReasoning(chunk: AssistantStreamChunk): string {
  return typeof chunk === 'string' ? '' : (chunk.reasoning ?? '');
}

export function toAssistantStreamChunk(content?: string, reasoning?: string): AssistantStreamChunk | undefined {
  if (reasoning) return { content, reasoning };
  if (content) return content;
  return undefined;
}
