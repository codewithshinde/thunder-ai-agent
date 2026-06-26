import type { LlmProvider, ChatMessage } from '../llm/types';
import type { ToolDefinition, ToolCall } from '../llm/toolTypes';
import type { ToolExecutor } from '../safety/ToolExecutor';
import { formatToolResult } from '../tools/builtinTools';
import { NO_TOOLS_AUDIT_NUDGE } from './taskKind';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('AgentLoop');

export interface AgentLoopCallbacks {
  onToolStart?: (name: string, input: Record<string, unknown>) => void;
  onToolEnd?: (name: string, success: boolean, output: string) => void;
  onStep?: (step: number, maxSteps: number) => void;
  onAutoContinue?: (step: number) => void;
  onPostWriteValidation?: (relPath: string, output: string) => string | undefined | Promise<string | undefined>;
}

export interface AgentLoopOptions {
  auditMode?: boolean;
  maxSteps?: number;
  autoContinue?: boolean;
  maxAutoContinues?: number;
}

export interface AgentLoopResult {
  fullContent: string;
  messages: ChatMessage[];
  toolCallsMade: number;
  pendingApproval: boolean;
}

export class AgentLoop {
  private lastPendingApproval = false;

  constructor(
    private readonly toolExecutor: ToolExecutor,
    private readonly defaultMaxSteps = 15
  ) {}

  hadPendingApproval(): boolean {
    return this.lastPendingApproval;
  }

  async *run(
    provider: LlmProvider,
    initialMessages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    callbacks?: AgentLoopCallbacks,
    options?: AgentLoopOptions
  ): AsyncIterable<string> {
    const messages: ChatMessage[] = [...initialMessages];
    let pendingApproval = false;
    this.lastPendingApproval = false;
    const maxSteps = options?.maxSteps ?? this.defaultMaxSteps;
    const auditMode = options?.auditMode ?? false;
    const autoContinue = options?.autoContinue ?? true;
    const maxAutoContinues = options?.maxAutoContinues ?? 2;
    let auditNudgeUsed = false;
    let autoContinuesUsed = 0;
    let totalSteps = 0;
    const hardLimit = maxSteps + maxAutoContinues * maxSteps;

    for (let step = 0; step < hardLimit; step++) {
      totalSteps = step + 1;
      if (signal?.aborted) break;
      const displayStep = ((step % maxSteps) + 1);
      callbacks?.onStep?.(displayStep, maxSteps);

      let stepContent = '';
      const toolCallsMap = new Map<number, ToolCall>();

      for await (const delta of provider.complete({
        messages,
        tools,
        toolChoice: 'auto',
        stream: true,
      })) {
        if (signal?.aborted) break;
        if (delta.error) throw new Error(delta.error);
        if (delta.content) {
          stepContent += delta.content;
          yield delta.content;
        }
        if (delta.tool_calls) {
          for (const partial of delta.tool_calls) {
            const existing = toolCallsMap.get(partial.index);
            if (!existing) {
              toolCallsMap.set(partial.index, {
                id: partial.id ?? `call_${partial.index}`,
                type: 'function',
                function: {
                  name: partial.function?.name ?? '',
                  arguments: partial.function?.arguments ?? '',
                },
              });
            } else {
              if (partial.id) existing.id = partial.id;
              if (partial.function?.name) existing.function.name += partial.function.name;
              if (partial.function?.arguments) existing.function.arguments += partial.function.arguments;
            }
          }
        }
        if (delta.done) break;
      }

      const toolCalls = toolCallsMap.size > 0
        ? Array.from(toolCallsMap.entries()).sort(([a], [b]) => a - b).map(([, tc]) => tc)
        : undefined;

      if (!toolCalls || toolCalls.length === 0) {
        if (auditMode && stepContent && !auditNudgeUsed) {
          auditNudgeUsed = true;
          messages.push({ role: 'assistant', content: stepContent });
          messages.push({ role: 'user', content: NO_TOOLS_AUDIT_NUDGE });
          continue;
        }
        if (stepContent) {
          messages.push({ role: 'assistant', content: stepContent });
        }
        break;
      }

      messages.push({
        role: 'assistant',
        content: stepContent,
        tool_calls: toolCalls,
      });

      const executions = await Promise.all(
        toolCalls.map(async (tc) => {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
          } catch {
            input = {};
          }
          callbacks?.onToolStart?.(tc.function.name, input);
          const execResult = await this.toolExecutor.execute(tc.function.name, input);
          return { tc, input, execResult };
        })
      );

      for (const { tc, input, execResult } of executions) {
        if (signal?.aborted) break;

        if (execResult.pendingApproval) {
          pendingApproval = true;
          callbacks?.onToolEnd?.(tc.function.name, false, 'Awaiting approval');
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: `Tool ${tc.function.name} is awaiting user approval. Stop and wait for the user to approve.`,
          });
          continue;
        }

        const output = execResult.success
          ? execResult.output
          : (execResult.error ?? 'Tool failed');

        callbacks?.onToolEnd?.(tc.function.name, execResult.success, output.slice(0, 500));

        let toolContent = formatToolResult(tc.function.name, {
          success: execResult.success,
          output: execResult.output,
          error: execResult.error,
        });

        if (
          execResult.success &&
          callbacks?.onPostWriteValidation &&
          ['write_file', 'apply_patch'].includes(tc.function.name)
        ) {
          const relPath = typeof input.path === 'string' ? input.path : '';
          if (relPath) {
            const validationNote = await callbacks.onPostWriteValidation(relPath, execResult.output);
            if (validationNote) {
              toolContent += `\n\n${validationNote}`;
            }
          }
        }

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: toolContent,
        });
      }

      if (pendingApproval) break;

      if (
        autoContinue &&
        autoContinuesUsed < maxAutoContinues &&
        step > 0 &&
        (step + 1) % maxSteps === 0 &&
        !pendingApproval
      ) {
        autoContinuesUsed += 1;
        callbacks?.onAutoContinue?.(autoContinuesUsed);
        messages.push({
          role: 'user',
          content: 'Continue the task from where you left off. Use tools as needed until complete.',
        });
        log.info('Auto-continuing agent loop', { continueRound: autoContinuesUsed });
      }
    }

    this.lastPendingApproval = pendingApproval;
    log.info('Agent loop finished', { pendingApproval, totalSteps });
  }

  async runToCompletion(
    provider: LlmProvider,
    initialMessages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    callbacks?: AgentLoopCallbacks,
    streamContent = false,
    options?: AgentLoopOptions
  ): Promise<AgentLoopResult> {
    const messages: ChatMessage[] = [...initialMessages];
    let fullContent = '';
    let toolCallsMade = 0;
    let pendingApproval = false;
    const maxSteps = options?.maxSteps ?? this.defaultMaxSteps;

    for (let step = 0; step < maxSteps; step++) {
      if (signal?.aborted) break;
      callbacks?.onStep?.(step + 1, maxSteps);

      const collected = await collectCompletion(provider, messages, tools, signal, streamContent && step === 0);

      if (collected.content) {
        fullContent += collected.content;
      }

      if (!collected.toolCalls || collected.toolCalls.length === 0) {
        if (collected.content) {
          messages.push({ role: 'assistant', content: collected.content });
        }
        break;
      }

      messages.push({
        role: 'assistant',
        content: collected.content ?? '',
        tool_calls: collected.toolCalls,
      });

      const executions = await Promise.all(
        collected.toolCalls.map(async (tc) => {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
          } catch {
            input = {};
          }
          callbacks?.onToolStart?.(tc.function.name, input);
          const execResult = await this.toolExecutor.execute(tc.function.name, input);
          toolCallsMade += 1;
          return { tc, execResult };
        })
      );

      for (const { tc, execResult } of executions) {
        if (signal?.aborted) break;

        if (execResult.pendingApproval) {
          pendingApproval = true;
          callbacks?.onToolEnd?.(tc.function.name, false, 'Awaiting approval');
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: `Tool ${tc.function.name} is awaiting user approval. Stop and wait for the user to approve.`,
          });
          continue;
        }

        const output = execResult.success
          ? execResult.output
          : (execResult.error ?? 'Tool failed');

        callbacks?.onToolEnd?.(tc.function.name, execResult.success, output.slice(0, 500));
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: formatToolResult(tc.function.name, {
            success: execResult.success,
            output: execResult.output,
            error: execResult.error,
          }),
        });
      }

      if (pendingApproval) break;
    }

    log.info('Agent loop finished', { toolCallsMade, pendingApproval });
    return { fullContent, messages, toolCallsMade, pendingApproval };
  }
}

interface CollectedCompletion {
  content: string;
  toolCalls?: ToolCall[];
}

async function collectCompletion(
  provider: LlmProvider,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
  stream = true
): Promise<CollectedCompletion> {
  let content = '';
  const toolCallsMap = new Map<number, ToolCall>();

  for await (const delta of provider.complete({
    messages,
    tools,
    toolChoice: 'auto',
    stream,
  })) {
    if (signal?.aborted) break;
    if (delta.error) throw new Error(delta.error);

    if (delta.content) {
      content += delta.content;
    }

    if (delta.tool_calls) {
      for (const partial of delta.tool_calls) {
        const existing = toolCallsMap.get(partial.index);
        if (!existing) {
          toolCallsMap.set(partial.index, {
            id: partial.id ?? `call_${partial.index}`,
            type: 'function',
            function: {
              name: partial.function?.name ?? '',
              arguments: partial.function?.arguments ?? '',
            },
          });
        } else {
          if (partial.id) existing.id = partial.id;
          if (partial.function?.name) existing.function.name += partial.function.name;
          if (partial.function?.arguments) existing.function.arguments += partial.function.arguments;
        }
      }
    }

    if (delta.done) break;
  }

  const toolCalls = toolCallsMap.size > 0
    ? Array.from(toolCallsMap.entries()).sort(([a], [b]) => a - b).map(([, tc]) => tc)
    : undefined;

  return { content, toolCalls };
}
