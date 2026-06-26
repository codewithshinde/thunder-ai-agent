import { existsSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../telemetry/Logger';

const execFileAsync = promisify(execFile);
const log = createLogger('MemoryHookService');

export interface HookContext {
  hookName: string;
  workspace: string;
  sessionId: string;
  userMessage?: string;
  toolName?: string;
  toolOutput?: string;
}

export interface HookResult {
  contextInjection?: string;
  cancel?: boolean;
}

/**
 * Hook-based context injection (claude-mem / Cline hooks pattern).
 * Runs optional scripts from `.thunder/hooks/<HookName>` and merges stdout as context.
 */
export class MemoryHookService {
  constructor(private readonly workspace: string) {}

  async runHook(hookName: string, ctx: Omit<HookContext, 'hookName'>): Promise<HookResult> {
    const hookPath = join(this.workspace, '.thunder', 'hooks', hookName);
    if (!existsSync(hookPath)) {
      return {};
    }

    try {
      const input = JSON.stringify({ ...ctx, hookName });
      const { stdout } = await execFileAsync(hookPath, [], {
        cwd: this.workspace,
        timeout: 5000,
        maxBuffer: 64 * 1024,
        env: { ...process.env, THUNDER_HOOK_INPUT: input },
      });

      const trimmed = stdout.trim();
      if (!trimmed) return {};

      try {
        const parsed = JSON.parse(trimmed) as HookResult;
        return parsed;
      } catch {
        return { contextInjection: trimmed.slice(0, 4000) };
      }
    } catch (error) {
      log.warn('Hook execution failed', {
        hook: hookName,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }

  async onUserPromptSubmit(sessionId: string, userMessage: string): Promise<string | undefined> {
    const result = await this.runHook('UserPromptSubmit', {
      workspace: this.workspace,
      sessionId,
      userMessage,
    });
    return result.contextInjection;
  }

  async onPostToolUse(
    sessionId: string,
    toolName: string,
    toolOutput: string
  ): Promise<string | undefined> {
    const result = await this.runHook('PostToolUse', {
      workspace: this.workspace,
      sessionId,
      toolName,
      toolOutput: toolOutput.slice(0, 2000),
    });
    return result.contextInjection;
  }
}
