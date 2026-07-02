import type { AssistantStreamChunk, LlmProvider, ChatMessage } from '../llm/types';
import type { ToolDefinition, ToolCall } from '../llm/toolTypes';
import { toAssistantStreamChunk } from '../llm/streamChunks';
import type { ToolExecutor } from '../safety/ToolExecutor';
import { formatToolResult } from '../tools/builtinTools';
import { NO_TOOLS_AUDIT_NUDGE } from './taskKind';
import { NO_TOOLS_ASK_NUDGE, ASK_SYNTHESIS_NUDGE, isGroundingToolCall } from './askMode';
import { NO_TOOLS_PLAN_NUDGE, PLAN_SYNTHESIS_NUDGE, isPlanGroundingToolCall } from '../modes/plan/planMode';
import { isSkippedToolOutput } from './toolSkip';
import type { PlanPhase, ThunderPlan } from '../plans/PlanActEngine';
import { isPhaseLockRunCommandError, isPhaseLockWriteError } from '../plans/PlanActEngine';
import { buildPlanTrackerPacket } from '../plans/PlanFileStore';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('AgentLoop');

const PHASE_LOCK_ESCALATION = `SYSTEM: File writes are blocked in the current read-only plan phase.
Do NOT retry apply_patch or write_file in this step.
If you finished analysis, summarize findings in plain text and stop — the orchestrator advances to the next step automatically.
If edits are required now, state exactly what must change and which files are affected.`;

const PHASE_LOCK_RUN_COMMAND_ESCALATION = `SYSTEM: The previous run_command calls were blocked by the current plan phase.
Do NOT retry the same arbitrary shell command.
In Verify, use the diagnostics tool or a recognized verification command. Read package.json scripts first — do not assume npm run lint exists. For docs/MDX tasks prefer the docs build (for example cd apps/docs && npm run build).
For targeted inspection, use read_file/search instead of shell. If verification cannot proceed, summarize the blocked command and the remaining risk.`;

const VALIDATION_BLOCK_MESSAGE =
  'Post-edit validation found errors. Fix all reported issues before marking this step complete or moving on.';

const REPEATED_TOOL_INPUT_FAILURE_PREFIX = 'Stopped after repeated invalid tool arguments';

export interface PostWriteValidationResult {
  message?: string;
  hasErrors: boolean;
}

export interface AgentLoopCallbacks {
  onToolStart?: (name: string, input: Record<string, unknown>) => void;
  onToolEnd?: (name: string, success: boolean, output: string, durationMs?: number) => void;
  onStep?: (step: number, maxSteps: number) => void;
  onLlmStepComplete?: (step: number, durationMs: number, toolCallCount: number) => void;
  onAutoContinue?: (step: number) => void;
  onPostWriteValidation?: (relPath: string, output: string) => PostWriteValidationResult | undefined | Promise<PostWriteValidationResult | undefined>;
}

export interface AgentLoopOptions {
  auditMode?: boolean;
  maxSteps?: number;
  autoContinue?: boolean;
  maxAutoContinues?: number;
  phaseLock?: PlanPhase;
  restrictRunCommandToReadOnly?: boolean;
  /** Active plan for state-invariant sync — injects locked MASTER PLAN TRACKER header. */
  planTracker?: ThunderPlan;
  /** Ask mode: retry once when the model answers without grounding tools. */
  askMode?: boolean;
  requiresAskGrounding?: boolean;
  /** Plan mode discovery / read-only fallback loop. */
  planMode?: boolean;
  requiresPlanGrounding?: boolean;
}

export interface AgentLoopSuspendState {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  options: AgentLoopOptions;
  checkpoint?: string;
}

export interface ApprovedToolResult {
  toolCallId: string;
  toolName: string;
  output: string;
  success: boolean;
  input?: Record<string, unknown>;
}

export interface AgentLoopResult {
  fullContent: string;
  messages: ChatMessage[];
  toolCallsMade: number;
  pendingApproval: boolean;
}

export class AgentLoop {
  private lastPendingApproval = false;
  private lastSuspendState: AgentLoopSuspendState | undefined;

  constructor(
    private readonly toolExecutor: ToolExecutor,
    private readonly defaultMaxSteps = 15
  ) {}

  hadPendingApproval(): boolean {
    return this.lastPendingApproval;
  }

  getSuspendState(): AgentLoopSuspendState | undefined {
    return this.lastSuspendState;
  }

  clearSuspendState(): void {
    this.lastSuspendState = undefined;
  }

  async *run(
    provider: LlmProvider,
    initialMessages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    callbacks?: AgentLoopCallbacks,
    options?: AgentLoopOptions
  ): AsyncIterable<AssistantStreamChunk> {
    const messages: ChatMessage[] = [...initialMessages];
    let pendingApproval = false;
    this.lastPendingApproval = false;
    this.lastSuspendState = undefined;
    const maxSteps = options?.maxSteps ?? this.defaultMaxSteps;
    const auditMode = options?.auditMode ?? false;
    const autoContinue = options?.autoContinue ?? true;
    const maxAutoContinues = options?.maxAutoContinues ?? 2;
    let auditNudgeUsed = false;
    let askNudgeUsed = false;
    let planNudgeUsed = false;
    let groundingToolCallsMade = false;
    let autoContinuesUsed = 0;
    let totalSteps = 0;
    let phaseLockWriteFailures = 0;
    let phaseLockRunCommandFailures = 0;
    let lastInputFailureKey = '';
    let repeatedInputFailureCount = 0;
    const hardLimit = maxSteps + maxAutoContinues * maxSteps;

    const readOnlyMode = Boolean(options?.askMode || options?.planMode);
    const isGroundingTool = (toolName: string): boolean =>
      options?.planMode ? isPlanGroundingToolCall(toolName) : isGroundingToolCall(toolName);

    this.toolExecutor.clearPlanPhaseLock?.();

    for (let step = 0; step < hardLimit; step++) {
      totalSteps = step + 1;
      if (signal?.aborted) break;
      const displayStep = ((step % maxSteps) + 1);
      callbacks?.onStep?.(displayStep, maxSteps);

      injectPlanTracker(messages, options?.planTracker);

      let stepContent = '';
      const toolCallsMap = new Map<number, ToolCall>();
      const llmStartedAt = Date.now();

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
        }
        const chunk = toAssistantStreamChunk(delta.content, delta.reasoning);
        if (chunk) yield chunk;
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

      callbacks?.onLlmStepComplete?.(displayStep, Date.now() - llmStartedAt, toolCalls?.length ?? 0);

      if (!toolCalls || toolCalls.length === 0) {
        if (auditMode && stepContent && !auditNudgeUsed) {
          auditNudgeUsed = true;
          messages.push({ role: 'assistant', content: stepContent });
          messages.push({ role: 'user', content: NO_TOOLS_AUDIT_NUDGE });
          continue;
        }
        if (
          options?.askMode &&
          options?.requiresAskGrounding &&
          stepContent &&
          !askNudgeUsed &&
          !groundingToolCallsMade
        ) {
          askNudgeUsed = true;
          messages.push({ role: 'assistant', content: stepContent });
          messages.push({ role: 'user', content: NO_TOOLS_ASK_NUDGE });
          continue;
        }
        if (
          options?.planMode &&
          options?.requiresPlanGrounding &&
          stepContent &&
          !planNudgeUsed &&
          !groundingToolCallsMade
        ) {
          planNudgeUsed = true;
          messages.push({ role: 'assistant', content: stepContent });
          messages.push({ role: 'user', content: NO_TOOLS_PLAN_NUDGE });
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
          const toolStartedAt = Date.now();
          const execResult = await this.toolExecutor.execute(tc.function.name, input, {
            toolCallId: tc.id,
            phaseLock: options?.phaseLock,
            restrictRunCommandToReadOnly: auditMode || options?.restrictRunCommandToReadOnly,
          });
          return { tc, input, execResult, durationMs: Date.now() - toolStartedAt };
        })
      );

      let phaseLockFailuresThisTurn = 0;
      let phaseLockRunCommandFailuresThisTurn = 0;
      let postWriteValidationFailed = false;
      let repeatedInputFailureStop: string | undefined;

      for (const { tc, input, execResult, durationMs } of executions) {
        if (signal?.aborted) break;

        if (execResult.success && isGroundingTool(tc.function.name)) {
          groundingToolCallsMade = true;
        }

        if (execResult.pendingApproval) {
          pendingApproval = true;
          callbacks?.onToolEnd?.(tc.function.name, false, 'Awaiting approval', durationMs);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: `Tool ${tc.function.name} is awaiting user approval. Stop and wait for the user to approve.`,
          });
          continue;
        }

        const { isSkipped, output, success: toolSuccess } = resolveToolOutput(execResult);

        if (
          !execResult.success &&
          !isSkipped &&
          ['write_file', 'apply_patch'].includes(tc.function.name) &&
          isPhaseLockWriteError(execResult.error)
        ) {
          phaseLockFailuresThisTurn += 1;
        }
        if (
          !execResult.success &&
          !isSkipped &&
          tc.function.name === 'run_command' &&
          isPhaseLockRunCommandError(execResult.error)
        ) {
          phaseLockRunCommandFailuresThisTurn += 1;
        }

        callbacks?.onToolEnd?.(
          tc.function.name,
          toolSuccess,
          isSkipped ? output : output.slice(0, 500),
          durationMs
        );

        let toolContent = formatToolResult(tc.function.name, {
          success: toolSuccess,
          output: isSkipped ? output : execResult.output,
          error: isSkipped ? undefined : execResult.error,
        });

        if (
          execResult.success &&
          callbacks?.onPostWriteValidation &&
          ['write_file', 'apply_patch'].includes(tc.function.name)
        ) {
          const relPath = typeof input.path === 'string' ? input.path : '';
          if (relPath) {
            const validation = await callbacks.onPostWriteValidation(relPath, execResult.output);
            if (validation?.message) {
              toolContent += `\n\n${validation.message}`;
            }
            if (validation?.hasErrors) {
              postWriteValidationFailed = true;
            }
          }
        }

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: toolContent,
        });

        const inputFailureKey = !execResult.success
          ? repeatedToolInputFailureKey(tc.function.name, output)
          : undefined;
        if (inputFailureKey) {
          if (inputFailureKey === lastInputFailureKey) {
            repeatedInputFailureCount += 1;
          } else {
            lastInputFailureKey = inputFailureKey;
            repeatedInputFailureCount = 1;
          }
          if (repeatedInputFailureCount >= 2) {
            repeatedInputFailureStop = buildRepeatedToolInputFailureMessage(
              tc.function.name,
              output,
              repeatedInputFailureCount
            );
          }
        } else if (execResult.success || !isRetriableToolFailure(output)) {
          lastInputFailureKey = '';
          repeatedInputFailureCount = 0;
        }
      }

      if (postWriteValidationFailed) {
        messages.push({ role: 'user', content: VALIDATION_BLOCK_MESSAGE });
      }

      if (phaseLockFailuresThisTurn > 0) {
        phaseLockWriteFailures += phaseLockFailuresThisTurn;
        if (phaseLockWriteFailures >= 2) {
          messages.push({ role: 'user', content: PHASE_LOCK_ESCALATION });
          phaseLockWriteFailures = 0;
        }
      }
      if (phaseLockRunCommandFailuresThisTurn > 0) {
        phaseLockRunCommandFailures += phaseLockRunCommandFailuresThisTurn;
        if (phaseLockRunCommandFailures >= 2) {
          messages.push({ role: 'user', content: PHASE_LOCK_RUN_COMMAND_ESCALATION });
          phaseLockRunCommandFailures = 0;
        }
      }

      if (repeatedInputFailureStop) {
        messages.push({ role: 'assistant', content: repeatedInputFailureStop });
        yield repeatedInputFailureStop;
        break;
      }

      if (pendingApproval) {
        const checkpoint = await createApprovalCheckpoint(provider, messages, options?.phaseLock, signal);
        this.lastSuspendState = {
          messages: [...messages],
          tools,
          options: {
            auditMode,
            maxSteps,
            autoContinue,
            maxAutoContinues,
            phaseLock: options?.phaseLock,
            restrictRunCommandToReadOnly: auditMode || options?.restrictRunCommandToReadOnly,
          },
          checkpoint,
        };
        break;
      }

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

    if (
      readOnlyMode &&
      groundingToolCallsMade &&
      !pendingApproval &&
      !signal?.aborted &&
      needsReadOnlySynthesis(messages)
    ) {
      const synthesisNudge = options?.planMode ? PLAN_SYNTHESIS_NUDGE : ASK_SYNTHESIS_NUDGE;
      messages.push({ role: 'user', content: synthesisNudge });
      callbacks?.onStep?.(1, 1);

      for await (const delta of provider.complete({
        messages,
        tools: [],
        toolChoice: 'none',
        stream: true,
      })) {
        if (signal?.aborted) break;
        if (delta.error) throw new Error(delta.error);
        const chunk = toAssistantStreamChunk(delta.content, delta.reasoning);
        if (chunk) yield chunk;
        if (delta.done) break;
      }
    }

    this.lastPendingApproval = pendingApproval;
    log.info('Agent loop finished', { pendingApproval, totalSteps });
  }

  async *resume(
    provider: LlmProvider,
    state: AgentLoopSuspendState,
    approved: ApprovedToolResult[],
    signal?: AbortSignal,
    callbacks?: AgentLoopCallbacks
  ): AsyncIterable<AssistantStreamChunk> {
    const messages: ChatMessage[] = state.messages.map((m) => ({ ...m }));
    const tools = state.tools;
    const options = state.options;
    let pendingApproval = false;
    this.lastPendingApproval = false;
    this.lastSuspendState = undefined;

    if (state.checkpoint) {
      injectWakeUpCheckpoint(messages, state.checkpoint);
    }

    let resumeValidationFailed = false;
    for (const result of approved) {
      const idx = messages.findIndex(
        (m) => m.role === 'tool' && m.tool_call_id === result.toolCallId
      );
      if (idx < 0) continue;

      callbacks?.onToolEnd?.(
        result.toolName,
        result.success,
        result.success ? result.output.slice(0, 500) : (result.output || 'Denied')
      );

      let toolContent = result.success
        ? formatToolResult(result.toolName, {
            success: true,
            output: result.output,
          })
        : `User denied ${result.toolName}. Do not retry the same command; choose another approach.`;

      if (
        result.success &&
        callbacks?.onPostWriteValidation &&
        ['write_file', 'apply_patch'].includes(result.toolName) &&
        result.input
      ) {
        const relPath = typeof result.input.path === 'string' ? result.input.path : '';
        if (relPath) {
          const validation = await callbacks.onPostWriteValidation(relPath, result.output);
          if (validation?.message) {
            toolContent += `\n\n${validation.message}`;
          }
          if (validation?.hasErrors) {
            resumeValidationFailed = true;
          }
        }
      }

      messages[idx] = {
        ...messages[idx],
        content: toolContent,
      };
    }

    if (resumeValidationFailed) {
      messages.push({ role: 'user', content: VALIDATION_BLOCK_MESSAGE });
    }

    const maxSteps = options.maxSteps ?? this.defaultMaxSteps;
    const auditMode = options.auditMode ?? false;
    const autoContinue = options.autoContinue ?? true;
    const maxAutoContinues = options.maxAutoContinues ?? 2;
    let auditNudgeUsed = false;
    let autoContinuesUsed = 0;
    let phaseLockRunCommandFailures = 0;
    const hardLimit = maxSteps + maxAutoContinues * maxSteps;

    for (let step = 0; step < hardLimit; step++) {
      if (signal?.aborted) break;
      const displayStep = ((step % maxSteps) + 1);
      callbacks?.onStep?.(displayStep, maxSteps);

      injectPlanTracker(messages, options.planTracker);

      let stepContent = '';
      const toolCallsMap = new Map<number, ToolCall>();
      const llmStartedAt = Date.now();

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
        }
        const chunk = toAssistantStreamChunk(delta.content, delta.reasoning);
        if (chunk) yield chunk;
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

      callbacks?.onLlmStepComplete?.(displayStep, Date.now() - llmStartedAt, toolCalls?.length ?? 0);

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
          const toolStartedAt = Date.now();
          const execResult = await this.toolExecutor.execute(tc.function.name, input, {
            toolCallId: tc.id,
            phaseLock: options.phaseLock,
            restrictRunCommandToReadOnly: options.restrictRunCommandToReadOnly,
          });
          return { tc, input, execResult, durationMs: Date.now() - toolStartedAt };
        })
      );

      let phaseLockRunCommandFailuresThisTurn = 0;
      let resumeStepValidationFailed = false;

      for (const { tc, input, execResult, durationMs } of executions) {
        if (signal?.aborted) break;

        if (execResult.pendingApproval) {
          pendingApproval = true;
          callbacks?.onToolEnd?.(tc.function.name, false, 'Awaiting approval', durationMs);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: `Tool ${tc.function.name} is awaiting user approval. Stop and wait for the user to approve.`,
          });
          continue;
        }

        const { isSkipped, output, success: toolSuccess } = resolveToolOutput(execResult);

        if (
          !execResult.success &&
          !isSkipped &&
          tc.function.name === 'run_command' &&
          isPhaseLockRunCommandError(execResult.error)
        ) {
          phaseLockRunCommandFailuresThisTurn += 1;
        }

        callbacks?.onToolEnd?.(
          tc.function.name,
          toolSuccess,
          isSkipped ? output : output.slice(0, 500),
          durationMs
        );

        let toolContent = formatToolResult(tc.function.name, {
          success: toolSuccess,
          output: isSkipped ? output : execResult.output,
          error: isSkipped ? undefined : execResult.error,
        });

        if (
          execResult.success &&
          callbacks?.onPostWriteValidation &&
          ['write_file', 'apply_patch'].includes(tc.function.name)
        ) {
          const relPath = typeof input.path === 'string' ? input.path : '';
          if (relPath) {
            const validation = await callbacks.onPostWriteValidation(relPath, execResult.output);
            if (validation?.message) {
              toolContent += `\n\n${validation.message}`;
            }
            if (validation?.hasErrors) {
              resumeStepValidationFailed = true;
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

      if (resumeStepValidationFailed) {
        messages.push({ role: 'user', content: VALIDATION_BLOCK_MESSAGE });
      }

      if (phaseLockRunCommandFailuresThisTurn > 0) {
        phaseLockRunCommandFailures += phaseLockRunCommandFailuresThisTurn;
        if (phaseLockRunCommandFailures >= 2) {
          messages.push({ role: 'user', content: PHASE_LOCK_RUN_COMMAND_ESCALATION });
          phaseLockRunCommandFailures = 0;
        }
      }

      if (pendingApproval) {
        const checkpoint = await createApprovalCheckpoint(provider, messages, options.phaseLock, signal);
        this.lastSuspendState = {
          messages: [...messages],
          tools,
          options,
          checkpoint,
        };
        break;
      }

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
        log.info('Auto-continuing agent loop after resume', { continueRound: autoContinuesUsed });
      }
    }

    this.lastPendingApproval = pendingApproval;
    log.info('Agent loop resume finished', { pendingApproval });
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
    let phaseLockRunCommandFailures = 0;

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
          const toolStartedAt = Date.now();
          const execResult = await this.toolExecutor.execute(tc.function.name, input, {
            phaseLock: options?.phaseLock,
            restrictRunCommandToReadOnly: options?.restrictRunCommandToReadOnly,
          });
          toolCallsMade += 1;
          return { tc, execResult, durationMs: Date.now() - toolStartedAt };
        })
      );

      let phaseLockRunCommandFailuresThisTurn = 0;

      for (const { tc, execResult, durationMs } of executions) {
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

        const { isSkipped, output, success: toolSuccess } = resolveToolOutput(execResult);

        if (
          !execResult.success &&
          !isSkipped &&
          tc.function.name === 'run_command' &&
          isPhaseLockRunCommandError(execResult.error)
        ) {
          phaseLockRunCommandFailuresThisTurn += 1;
        }

        callbacks?.onToolEnd?.(
          tc.function.name,
          toolSuccess,
          isSkipped ? output : output.slice(0, 500),
          durationMs
        );
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: formatToolResult(tc.function.name, {
            success: toolSuccess,
            output: isSkipped ? output : execResult.output,
            error: isSkipped ? undefined : execResult.error,
          }),
        });
      }

      if (phaseLockRunCommandFailuresThisTurn > 0) {
        phaseLockRunCommandFailures += phaseLockRunCommandFailuresThisTurn;
        if (phaseLockRunCommandFailures >= 2) {
          messages.push({ role: 'user', content: PHASE_LOCK_RUN_COMMAND_ESCALATION });
          phaseLockRunCommandFailures = 0;
        }
      }

      if (pendingApproval) {
        const checkpoint = await createApprovalCheckpoint(provider, messages, options?.phaseLock, signal);
        this.lastSuspendState = {
          messages: [...messages],
          tools,
          options: options ?? {},
          checkpoint,
        };
        break;
      }
    }

    log.info('Agent loop finished', { toolCallsMade, pendingApproval });
    return { fullContent, messages, toolCallsMade, pendingApproval };
  }
}

async function createApprovalCheckpoint(
  provider: LlmProvider,
  messages: ChatMessage[],
  phaseLock?: PlanPhase,
  signal?: AbortSignal
): Promise<string | undefined> {
  if (signal?.aborted) return undefined;

  const compactMessages = messages
    .slice(-12)
    .map((m) => {
      const tool = m.role === 'tool' ? ` (${m.name ?? 'tool'})` : '';
      return `${m.role}${tool}: ${m.content.slice(0, 2000)}`;
    })
    .join('\n\n');

  const checkpointMessages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'Summarize coding-agent progress for resuming after a user approval pause. Output only a compact checkpoint with: current phase, completed facts/tool results, pending approval action, and exact next step. Max 180 words.',
    },
    {
      role: 'user',
      content: `Current phase lock: ${phaseLock ?? 'none'}\n\nRecent state:\n${compactMessages}`,
    },
  ];

  let response = '';
  try {
    for await (const delta of provider.complete({
      messages: checkpointMessages,
      stream: false,
      toolChoice: 'none',
    })) {
      if (signal?.aborted) return undefined;
      if (delta.error) throw new Error(delta.error);
      if (delta.content) response += delta.content;
      if (delta.done) break;
    }
  } catch (error) {
    log.warn('Approval checkpoint generation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }

  return response.trim().slice(0, 1200) || undefined;
}

function injectPlanTracker(messages: ChatMessage[], plan?: ThunderPlan): void {
  if (!plan) return;

  const trackerContent = buildPlanTrackerPacket(plan);
  const marker = '[MASTER PLAN TRACKER';
  const existingIdx = messages.findIndex(
    (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes(marker)
  );

  if (existingIdx >= 0) {
    messages[existingIdx] = { role: 'system', content: trackerContent };
  } else {
    const systemIdx = messages.findIndex((m) => m.role === 'system');
    if (systemIdx >= 0) {
      messages.splice(systemIdx + 1, 0, { role: 'system', content: trackerContent });
    } else {
      messages.unshift({ role: 'system', content: trackerContent });
    }
  }
}

function injectWakeUpCheckpoint(messages: ChatMessage[], checkpoint: string): void {
  const wakeUp: ChatMessage = {
    role: 'system',
    content:
      `APPROVAL WAKE-UP CHECKPOINT:\n${checkpoint}\n\nResume from this checkpoint. Trust it over stale instinct, do not repeat completed discovery, and continue with the approved action/result.`,
  };

  const systemIndex = messages.findIndex((m) => m.role === 'system');
  if (systemIndex >= 0) {
    messages.splice(systemIndex + 1, 0, wakeUp);
  } else {
    messages.unshift(wakeUp);
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

/** True when the loop ended after tool exploration without a substantive final answer. */
export function needsReadOnlySynthesis(messages: ChatMessage[]): boolean {
  const assistants = messages.filter((m) => m.role === 'assistant');
  const lastAssistant = assistants[assistants.length - 1];
  if (!lastAssistant) return true;
  if (lastAssistant.tool_calls && lastAssistant.tool_calls.length > 0) return true;

  const content = (lastAssistant.content ?? '').trim();
  if (!content) return true;
  if (content.length < 160 && /\b(let me|i will|i'll|fetching|checking|searching|reading)\b/i.test(content)) {
    return true;
  }
  return false;
}

function resolveToolOutput(execResult: import('../safety/ToolExecutor').ToolExecutionResult): {
  isSkipped: boolean;
  output: string;
  success: boolean;
} {
  const isSkipped = Boolean(execResult.skipped) ||
    isSkippedToolOutput(execResult.output) ||
    isSkippedToolOutput(execResult.error);
  const output = execResult.success
    ? execResult.output
    : isSkipped
      ? (execResult.output || execResult.error || 'Skipped redundant tool call')
      : (execResult.error ?? 'Tool failed');
  return {
    isSkipped,
    output,
    success: execResult.success || isSkipped,
  };
}

function repeatedToolInputFailureKey(toolName: string, output: string): string | undefined {
  if (!isToolInputValidationFailure(output)) return undefined;
  return `${toolName}:${normalizeToolFailure(output)}`;
}

function isToolInputValidationFailure(output: string): boolean {
  return /\b(input validation error|invalid input|invalid arguments for tool|expected .* received undefined)\b/i.test(output);
}

function isRetriableToolFailure(output: string): boolean {
  return isToolInputValidationFailure(output);
}

function normalizeToolFailure(output: string): string {
  return output.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function buildRepeatedToolInputFailureMessage(toolName: string, output: string, count: number): string {
  const detail = normalizeToolFailure(output).slice(0, 320);
  return [
    `\n\n### ${REPEATED_TOOL_INPUT_FAILURE_PREFIX}`,
    '',
    `The agent stopped after ${count} consecutive invalid \`${toolName}\` calls. The tool rejected the arguments before execution: ${detail}`,
    '',
    'I will not keep retrying the same malformed tool call. The next attempt should use a registered tool with all required arguments, or explain the blocker instead.',
  ].join('\n');
}
