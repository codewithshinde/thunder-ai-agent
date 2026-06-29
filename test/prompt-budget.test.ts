import { describe, expect, it } from 'vitest';
import { fitChatRequestToBudget, getMaxInputTokens } from '../src/core/agent/PromptBudget';
import { estimateChatRequestTokens } from '../src/core/llm/UsageTrackingProvider';

describe('PromptBudget', () => {
  it('reserves output headroom from the configured window', () => {
    expect(getMaxInputTokens(20_000)).toBe(17_000);
  });

  it('trims oversized prompts to the input budget', () => {
    const hugeContext = 'x'.repeat(120_000);
    const request = {
      messages: [
        { role: 'system' as const, content: 'You are an agent.' },
        {
          role: 'user' as const,
          content: `## Codebase Context\n\n${hugeContext}\n\n---\n\n## User request\n\nhello`,
        },
      ],
    };

    const maxInputTokens = getMaxInputTokens(20_000);
    const fitted = fitChatRequestToBudget(request, maxInputTokens);

    expect(fitted.trimmed).toBe(true);
    expect(fitted.afterTokens).toBeLessThanOrEqual(maxInputTokens);
    expect(estimateChatRequestTokens(fitted.request)).toBeLessThanOrEqual(maxInputTokens);
  });

  it('shrinks multi-step tool transcripts to fit the budget', () => {
    const request = {
      messages: [
        { role: 'system' as const, content: 'system' },
        { role: 'tool' as const, content: 'o'.repeat(8_000), tool_call_id: '1', name: 'read_file' },
        { role: 'tool' as const, content: 'n'.repeat(8_000), tool_call_id: '2', name: 'read_file' },
        { role: 'tool' as const, content: 'm'.repeat(8_000), tool_call_id: '3', name: 'read_file' },
        { role: 'tool' as const, content: 'l'.repeat(8_000), tool_call_id: '4', name: 'read_file' },
        { role: 'tool' as const, content: 'k'.repeat(8_000), tool_call_id: '5', name: 'read_file' },
        { role: 'user' as const, content: 'continue' },
      ],
    };

    const fitted = fitChatRequestToBudget(request, 4_000);

    expect(fitted.trimmed).toBe(true);
    expect(fitted.afterTokens).toBeLessThanOrEqual(4_000);
    expect(fitted.request.messages.length).toBeLessThan(request.messages.length);
  });
});
