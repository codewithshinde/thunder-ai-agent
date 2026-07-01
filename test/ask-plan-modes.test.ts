import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ChatMessage } from '../src/core/llm/types';
import type { ToolExecutor } from '../src/core/safety/ToolExecutor';
import type { LlmProvider } from '../src/core/llm/types';

describe('Ask and Plan mode reliability', () => {
  it('distinguishes git diff cached vs unstaged diagnostic keys', async () => {
    const { normalizeDiagnosticKey } = await import('../src/core/runtime/AgentTaskState');

    expect(normalizeDiagnosticKey('git diff')).toBe('git-diff:unstaged');
    expect(normalizeDiagnosticKey('git diff --cached')).toBe('git-diff:cached');
    expect(normalizeDiagnosticKey('git diff --staged')).toBe('git-diff:cached');
    expect(normalizeDiagnosticKey('git diff HEAD -- src/foo.ts')).toBe('git-diff:head');
  });

  it('does not block git diff --cached after git diff unstaged in agent mode', async () => {
    const { AgentTaskState } = await import('../src/core/runtime/AgentTaskState');
    const state = new AgentTaskState();
    state.setTaskContext('question', 'commit message', 'commit message for staged changes');
    state.recordToolSuccess('run_command', { command: 'git diff' }, '(no changes)');

    expect(state.checkBlocked('run_command', { command: 'git diff --cached' })).toBeNull();
    expect(state.checkBlocked('run_command', { command: 'git diff' })).toContain('git-diff:unstaged');
  });

  it('skips AgentTaskState redundant blocking in Ask mode via ToolExecutor', async () => {
    const { ToolExecutor } = await import('../src/core/safety/ToolExecutor');
    const { AgentTaskState } = await import('../src/core/runtime/AgentTaskState');
    const taskState = new AgentTaskState();
    taskState.setTaskContext('question', 'commit message', 'commit message');
    taskState.recordToolSuccess('run_command', { command: 'git diff' }, '(no changes)');

    const executor = new ToolExecutor(
      {
        execute: vi.fn(async () => ({ success: true, output: 'cached diff' })),
      } as never,
      { evaluate: () => ({ decision: 'allow' }) } as never,
      { hasApprovalGrant: () => true, createRequest: vi.fn() } as never,
      () => 'session-1',
      () => 'ask',
      undefined,
      () => taskState
    );

    const result = await executor.execute('run_command', { command: 'git diff --cached' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('cached diff');
  });

  it('detects interim Ask responses that need synthesis', async () => {
    const { needsReadOnlySynthesis } = await import('../src/core/runtime/AgentLoop');
    const messages: ChatMessage[] = [
      { role: 'user', content: 'commit message please' },
      {
        role: 'assistant',
        content: 'The changes appear to be staged. Let me fetch the staged diff:',
        tool_calls: [{ id: '1', type: 'function', function: { name: 'run_command', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: '1', name: 'run_command', content: 'diff output' },
    ];

    expect(needsReadOnlySynthesis(messages)).toBe(true);
  });

  it('does not re-synthesize when a substantive answer already exists', async () => {
    const { needsReadOnlySynthesis } = await import('../src/core/runtime/AgentLoop');
    const messages: ChatMessage[] = [
      { role: 'user', content: 'how does auth work?' },
      {
        role: 'assistant',
        content: 'Authentication is handled in `src/auth/handler.ts` via JWT middleware. The login route validates credentials and issues a signed token used on subsequent API requests.',
      },
    ];

    expect(needsReadOnlySynthesis(messages)).toBe(false);
  });

  it('runs a final synthesis turn after tool-only Ask exploration', async () => {
    const { AgentLoop } = await import('../src/core/runtime/AgentLoop');
    let llmCalls = 0;
    const provider = {
      id: 'mock',
      capabilities: {
        supportsTools: true,
        supportsStreaming: true,
        contextWindow: 8192,
        supportsEmbeddings: false,
      },
      async *complete(request: { messages: ChatMessage[]; tools?: unknown[]; toolChoice?: string }) {
        llmCalls += 1;
        if (llmCalls === 1) {
          yield {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              function: { name: 'read_file', arguments: '{"path":"src/index.ts"}' },
            }],
          };
        } else {
          expect(request.toolChoice).toBe('none');
          expect(request.tools).toEqual([]);
          yield { content: 'Auth uses JWT in `src/index.ts:12`.' };
        }
        yield { done: true };
      },
    } as LlmProvider;

    const toolExecutor = {
      execute: vi.fn(async () => ({ success: true, output: 'file contents' })),
      clearPlanPhaseLock: vi.fn(),
    } as unknown as ToolExecutor;

    const loop = new AgentLoop(toolExecutor, 1);
    const chunks: string[] = [];
    for await (const chunk of loop.run(
      provider,
      [{ role: 'user', content: 'How does auth work in this repo?' }],
      [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: {} } }],
      undefined,
      undefined,
      { askMode: true, requiresAskGrounding: true, maxSteps: 1, maxAutoContinues: 0 }
    )) {
      chunks.push(chunk);
    }

    expect(chunks.join('')).toContain('JWT');
    expect(llmCalls).toBe(2);
  });

  it('nudges Plan mode when answering without grounding tools', async () => {
    const { AgentLoop } = await import('../src/core/runtime/AgentLoop');
    const seen: string[] = [];
    let llmCalls = 0;
    const provider = {
      id: 'mock',
      capabilities: {
        supportsTools: true,
        supportsStreaming: true,
        contextWindow: 8192,
        supportsEmbeddings: false,
      },
      async *complete(request: { messages: ChatMessage[] }) {
        llmCalls += 1;
        const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
        if (lastUser?.content) seen.push(lastUser.content);

        if (llmCalls === 1) {
          yield { content: 'Here is a plan without reading anything.' };
        } else if (llmCalls === 2) {
          yield {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              function: { name: 'search', arguments: '{"query":"planner"}' },
            }],
          };
        } else {
          yield { content: 'DISCOVERY_SUMMARY: PlanExecutor handles planning.' };
        }
        yield { done: true };
      },
    } as LlmProvider;

    const toolExecutor = {
      execute: vi.fn(async () => ({ success: true, output: 'matches' })),
      clearPlanPhaseLock: vi.fn(),
    } as unknown as ToolExecutor;

    const loop = new AgentLoop(toolExecutor, 3);
    const chunks: string[] = [];
    for await (const chunk of loop.run(
      provider,
      [{ role: 'user', content: 'Plan the planner refactor' }],
      [{ type: 'function', function: { name: 'search', description: 'search', parameters: {} } }],
      undefined,
      undefined,
      { planMode: true, requiresPlanGrounding: true, maxSteps: 3 }
    )) {
      chunks.push(chunk);
    }

    expect(seen.some((text) => text.includes('Plan mode MUST be grounded'))).toBe(true);
    expect(chunks.join('')).toContain('DISCOVERY_SUMMARY');
  });

  it('uses structured planner in Plan mode even when orchestration is disabled', async () => {
    const { shouldUsePlanner } = await import('../src/core/orchestration/ChatOrchestrator');
    const { analyzeTask } = await import('../src/core/runtime/TaskAnalyzer');

    const analysis = analyzeTask('How does authentication work in this repo?', 'plan');
    expect(analysis.shouldPlan).toBe(true);
    expect(shouldUsePlanner('plan', analysis, false, false)).toBe(true);
    expect(shouldUsePlanner('agent', analysis, false, false)).toBe(false);
  });

  it('prepares Plan mode with depth-aware discovery budgets', async () => {
    const { PlanOrchestrator } = await import('../src/core/modes/plan/PlanOrchestrator');
    const quick = PlanOrchestrator.prepare('Implement SDK plan runner', { planDepth: 'quick' });
    const deep = PlanOrchestrator.prepare('Implement SDK plan runner', { planDepth: 'deep' });

    expect(quick.discoveryMaxSteps).toBeLessThan(deep.discoveryMaxSteps);
    expect(quick.promptContext).toContain('Plan routing');
  });

  it('parses SKILL.md frontmatter descriptions for the skill catalog', async () => {
    const { parseSkillFrontmatter } = await import('../src/core/skills/SkillCatalogService');
    const parsed = parseSkillFrontmatter(`---
name: performance-optimization
description: >
  Optimizes application performance when Core Web Vitals
  need improvement.
---

# Performance Optimization
`);

    expect(parsed.name).toBe('performance-optimization');
    expect(parsed.description).toContain('Core Web Vitals');
  });

  it('uses SKILL.md frontmatter names in the refreshed skill catalog', async () => {
    const { SkillCatalogService } = await import('../src/core/skills/SkillCatalogService');
    const workspace = mkdtempSync(join(tmpdir(), 'thunder-skill-catalog-'));
    try {
      const skillDir = join(workspace, '.mitii', 'skills', 'perf-folder');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `---
name: performance-optimization
description: "Measure-first performance work for LCP, INP, CLS, API latency, and bundles."
---

# Performance Optimization
`, 'utf8');

      const catalog = new SkillCatalogService(workspace);
      const entries = catalog.refresh();
      const saved = JSON.parse(readFileSync(join(workspace, '.mitii', 'skills', 'catalog.json'), 'utf8'));

      expect(entries).toEqual([{
        name: 'performance-optimization',
        description: 'Measure-first performance work for LCP, INP, CLS, API latency, and bundles.',
        relPath: '.mitii/skills/perf-folder/SKILL.md',
      }]);
      expect(saved[0].name).toBe('performance-optimization');
      expect(catalog.get('performance-optimization')?.entry.name).toBe('performance-optimization');
      expect(catalog.get('perf-folder')?.entry.name).toBe('performance-optimization');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('defaults planDepth in agent config schema', async () => {
    const { AgentConfigSchema } = await import('../src/core/config/schema');
    const parsed = AgentConfigSchema.parse({});
    expect(parsed.planDepth).toBe('auto');
  });

  it('installs bundled skills from the extension into the workspace', async () => {
    const { installBundledSkills, listBundledSkillNames } = await import('../src/core/skills/installBundledSkills');
    const { fileURLToPath } = await import('url');
    const extensionRoot = join(fileURLToPath(new URL('..', import.meta.url)));

    expect(listBundledSkillNames(extensionRoot).length).toBeGreaterThanOrEqual(8);

    const workspace = mkdtempSync(join(tmpdir(), 'thunder-bundled-skills-'));
    try {
      const first = installBundledSkills(workspace, extensionRoot);
      expect(first.installed).toContain('audit-cleanup');
      expect(first.installed).toContain('performance-optimization');
      expect(existsSync(join(workspace, '.mitii', 'skills', 'audit-cleanup', 'SKILL.md'))).toBe(true);

      const second = installBundledSkills(workspace, extensionRoot);
      expect(second.installed).toEqual([]);
      expect(second.skipped.length).toBeGreaterThan(0);

      const forced = installBundledSkills(workspace, extensionRoot, { force: true });
      expect(forced.installed.length).toBeGreaterThan(0);

      const catalog = new (await import('../src/core/skills/SkillCatalogService')).SkillCatalogService(workspace);
      const entries = catalog.refresh();
      expect(entries.some((entry) => entry.name === 'audit-cleanup')).toBe(true);
      expect(entries.some((entry) => entry.name === 'using-agent-skills')).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('scaffoldMitiiWorkspace copies bundled skills when extensionRoot is provided', async () => {
    const { scaffoldMitiiWorkspace } = await import('../src/core/mcp/scaffoldMitiiWorkspace');
    const { fileURLToPath } = await import('url');
    const extensionRoot = join(fileURLToPath(new URL('..', import.meta.url)));
    const workspace = mkdtempSync(join(tmpdir(), 'thunder-scaffold-skills-'));

    try {
      scaffoldMitiiWorkspace(workspace, { extensionRoot });
      expect(existsSync(join(workspace, '.mitii', 'skills', 'planning-and-task-breakdown', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(workspace, '.mitii', 'mcp.json'))).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
