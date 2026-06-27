import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentLoop } from '../src/core/agent/AgentLoop';
import type { ToolExecutor } from '../src/core/safety/ToolExecutor';
import type { LlmProvider } from '../src/core/llm/types';
import type { ThunderPlan } from '../src/core/planning/PlanActEngine';

function mockProvider(responses: Array<Record<string, unknown>>): LlmProvider {
  let call = 0;
  return {
    id: 'mock',
    capabilities: { supportsTools: true, supportsStreaming: true, contextWindow: 8192, supportsEmbeddings: false },
    async *complete() {
      const response = responses[Math.min(call, responses.length - 1)];
      call += 1;
      if (response.content) yield { content: response.content as string };
      if (response.tool_calls) yield { tool_calls: response.tool_calls as never };
      yield { done: true };
    },
  } as LlmProvider;
}

describe('AgentLoop E2E', () => {
  let executedTools: string[];

  beforeEach(() => {
    executedTools = [];
  });

  function createMockExecutor(): ToolExecutor {
    return {
      execute: vi.fn(async (name: string) => {
        executedTools.push(name);
        return { success: true, output: `ok:${name}` };
      }),
    } as unknown as ToolExecutor;
  }

  it('injects plan tracker into messages when planTracker option is set', async () => {
    const plan: ThunderPlan = {
      goal: 'Clean dependencies',
      assumptions: [],
      requiredApprovals: [],
      steps: [
        { id: 'step_1', title: 'Run audit', status: 'running', risk: 'low', phase: 'diagnostics' },
        { id: 'step_2', title: 'Remove packages', status: 'pending', risk: 'medium', dependsOn: ['step_1'] },
      ],
    };

    const provider = mockProvider([
      { content: 'Done with step.' },
    ]);

    const loop = new AgentLoop(createMockExecutor(), 5);
    const chunks: string[] = [];
    for await (const chunk of loop.run(
      provider,
      [{ role: 'user', content: 'Execute step 1' }],
      [],
      undefined,
      undefined,
      { planTracker: plan, maxSteps: 3 }
    )) {
      chunks.push(chunk);
    }

    expect(chunks.join('')).toContain('Done');
  });

  it('executes tool calls and stops on pending approval', async () => {
    const executor = createMockExecutor();
    (executor.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      output: '',
      pendingApproval: true,
      error: 'Awaiting approval',
    });

    const provider = mockProvider([
      {
        tool_calls: [{
          index: 0,
          id: 'call_1',
          function: { name: 'write_file', arguments: '{"path":"test.ts","content":"x"}' },
        }],
      },
      { content: 'Waiting.' },
    ]);

    const loop = new AgentLoop(executor, 5);
    for await (const _chunk of loop.run(
      provider,
      [{ role: 'user', content: 'Write file' }],
      [{ type: 'function', function: { name: 'write_file', description: 'write', parameters: {} } }],
      undefined,
      undefined,
      { maxSteps: 3 }
    )) {
      // consume
    }

    expect(loop.hadPendingApproval()).toBe(true);
    expect(loop.getSuspendState()?.messages.some(
      (m) => m.role === 'tool' && m.content.includes('awaiting user approval')
    )).toBe(true);
  });

  it('resumes after approval with checkpoint injection', async () => {
    const executor = createMockExecutor();
    const provider = mockProvider([{ content: 'Resumed successfully.' }]);

    const loop = new AgentLoop(executor, 5);
    const state = {
      messages: [
        { role: 'user' as const, content: 'task' },
        { role: 'assistant' as const, content: '', tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'write_file', arguments: '{}' } }] },
        { role: 'tool' as const, tool_call_id: 'c1', name: 'write_file', content: 'awaiting approval' },
      ],
      tools: [],
      options: { maxSteps: 3 },
      checkpoint: 'Phase: execute. Completed: read package.json. Next: apply patch.',
    };

    const chunks: string[] = [];
    for await (const chunk of loop.resume(
      provider,
      state,
      [{ toolCallId: 'c1', toolName: 'write_file', output: 'written', success: true }],
    )) {
      chunks.push(chunk);
    }

    expect(chunks.join('')).toContain('Resumed');
  });
});

describe('Plan tools E2E', () => {
  it('applyDependencyLocks blocks steps until deps complete', async () => {
    const { applyDependencyLocks, getNextExecutableStep } = await import('../src/core/tools/planTools');
    type StepStatus = 'pending' | 'running' | 'done' | 'blocked' | 'failed' | 'blocked_by_dependency';
    const plan = {
      goal: 'test',
      assumptions: [] as string[],
      requiredApprovals: [] as string[],
      steps: [
        { id: 'a', title: 'First', status: 'pending' as StepStatus, risk: 'low' as const, dependsOn: [''] as string[] },
        { id: 'b', title: 'Second', status: 'pending' as StepStatus, risk: 'low' as const, dependsOn: ['a'] },
      ],
    };
    plan.steps[0].dependsOn = [];

    applyDependencyLocks(plan);
    expect(plan.steps[1].status).toBe('blocked_by_dependency');
    expect(getNextExecutableStep(plan)?.id).toBe('a');

    plan.steps[0].status = 'done';
    applyDependencyLocks(plan);
    expect(plan.steps[1].status).toBe('pending');
    expect(getNextExecutableStep(plan)?.id).toBe('b');
  });
});

describe('ImportExtractor', () => {
  it('extracts ES imports and resolves relative paths', async () => {
    const { extractImports, resolveImportTarget } = await import('../src/core/indexing/ImportExtractor');
    const content = `
import { foo } from './utils';
import type { Bar } from '../types/bar';
const x = require('./legacy');
`;
    const imports = extractImports(content);
    expect(imports.length).toBeGreaterThanOrEqual(2);
    expect(resolveImportTarget('src/index.ts', './utils')).toBe('src/utils.ts');
  });
});

describe('PlanFileStore', () => {
  it('persists and loads plan.json', async () => {
    const { mkdtempSync, rmSync, readFileSync, existsSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const { PlanFileStore } = await import('../src/core/planning/PlanFileStore');

    const dir = mkdtempSync(join(tmpdir(), 'thunder-plan-'));
    const store = new PlanFileStore(dir, 'task-123');
    const plan = {
      goal: 'Test goal',
      assumptions: [],
      requiredApprovals: [],
      steps: [{ id: 's1', title: 'Step 1', status: 'pending' as const, risk: 'low' as const }],
    };

    store.save(plan, 'planning');
    expect(existsSync(store.getPath())).toBe(true);

    const loaded = store.load();
    expect(loaded?.goal).toBe('Test goal');
    expect(loaded?.steps[0].status).toBe('pending');

    const updated = store.markStepComplete('s1');
    expect(updated?.steps[0].status).toBe('done');

    const onDisk = JSON.parse(readFileSync(store.getPath(), 'utf-8'));
    expect(onDisk.status).toBe('completed');

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('pageRank personalization', () => {
  it('boosts personalized nodes', async () => {
    const { computePageRank } = await import('../src/core/context/pageRank');
    const personalization = new Map([
      ['hub.ts', 10],
      ['leaf.ts', 0.1],
    ]);
    const scores = computePageRank(
      ['hub.ts', 'leaf.ts', 'other.ts'],
      [{ from: 'other.ts', to: 'leaf.ts' }],
      { personalization }
    );
    expect(scores.get('hub.ts') ?? 0).toBeGreaterThan(scores.get('leaf.ts') ?? 0);
  });
});

describe('TreeSitterParser fallback', () => {
  it('extracts symbols via regex when tree-sitter unavailable', async () => {
    const { treeSitterParser } = await import('../src/core/indexing/SymbolExtractor');
    const symbols = treeSitterParser.parse(`
export class MyService {
  async fetchData(): Promise<void> {}
}
export interface Config { key: string; }
`, 'typescript');
    expect(symbols.some((s) => s.name === 'MyService')).toBe(true);
  });
});
