import type { ChatDelta } from './types';
import { ProviderError } from './errors';

export async function* parseSseStream(
  body: ReadableStream<Uint8Array>
): AsyncIterable<ChatDelta> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') {
          continue;
        }
        if (!trimmed.startsWith('data: ')) {
          continue;
        }

        try {
          const json = JSON.parse(trimmed.slice(6)) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
            error?: { message?: string };
          };

          if (json.error?.message) {
            throw new ProviderError(json.error.message, 'parse');
          }

          const content = json.choices?.[0]?.delta?.content;
          if (content) {
            yield { content };
          }

          if (json.choices?.[0]?.finish_reason) {
            yield { done: true };
          }
        } catch (e) {
          if (e instanceof ProviderError) {
            throw e;
          }
          // Skip malformed SSE lines
        }
      }
    }
    yield { done: true };
  } finally {
    reader.releaseLock();
  }
}
