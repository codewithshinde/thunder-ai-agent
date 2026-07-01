import { describe, expect, it } from 'vitest';
import { ActOrchestrator, filterActModeTools, routeActIntent, shouldResumeSavedPlan } from '../../src/core/act';
import { analyzeTask } from '../../src/core/agent/TaskAnalyzer';
import { resolveMaxContextItems } from '../../src/core/context/resolveMaxContextItems';
import type { ToolDefinition } from '../../src/core/llm/toolTypes';
import { buildSystemPrompt } from '../../src/core/planning/promptBuilder';
import type { SkillCatalogService } from '../../src/core/skills/SkillCatalogService';

describe('Act orchestration boundary', () => {
  it('recognizes explicit and natural saved-plan handoff phrases', () => {
    expect(shouldResumeSavedPlan('execute the plan', true)).toBe(true);
    expect(shouldResumeSavedPlan('plan looks good, implement it', true)).toBe(true);
    expect(shouldResumeSavedPlan('go ahead', true)).toBe(true);
    expect(shouldResumeSavedPlan('fix it', true)).toBe(true);
    expect(shouldResumeSavedPlan('go ahead', false)).toBe(false);
  });

  it('routes active-plan handoffs before replanning', () => {
    const analysis = analyzeTask('Implement the approved SDK scaffold', 'agent');
    const route = routeActIntent('implement it', analysis, {
      mode: 'agent',
      hasActivePlan: true,
      orchestrationEnabled: true,
    });

    expect(route.intent).toBe('resume_plan');
    expect(route.executionPath).toBe('resume_saved_plan');
    expect(route.shouldUsePlanner).toBe(false);
  });

  it('keeps audit tasks on the script-first direct Act path', () => {
    const analysis = analyzeTask('find unused dependencies and clean them up safely', 'agent');
    const route = routeActIntent('find unused dependencies and clean them up safely', analysis, {
      mode: 'agent',
      hasActivePlan: false,
      orchestrationEnabled: true,
      auditMode: true,
    });

    expect(route.intent).toBe('audit');
    expect(route.executionPath).toBe('audit');
    expect(route.shouldUsePlanner).toBe(false);
    expect(route.shouldVerify).toBe(true);
  });

  it('uses orchestrated Act for complex implementation when orchestration is enabled', () => {
    const message = 'Implement the Act SDK boundary, add tests, and update docs';
    const analysis = analyzeTask(message, 'agent');
    const route = routeActIntent(message, analysis, {
      mode: 'agent',
      hasActivePlan: false,
      orchestrationEnabled: true,
    });

    expect(route.executionPath).toBe('orchestrated');
    expect(route.shouldUsePlanner).toBe(true);
    expect(route.intent).toBe('docs');
  });

  it('prepares SDK-aligned Act run plans with skills and saved plan metadata', () => {
    const skillCatalog = {
      get(name: string) {
        if (name !== 'debugging-and-error-recovery') return undefined;
        return {
          entry: {
            name: 'debugging-and-error-recovery',
            description: 'Debug failures',
            relPath: '.mitii/skills/debugging-and-error-recovery/SKILL.md',
          },
          content: '# Debugging\n\nReproduce, isolate, fix, verify.',
        };
      },
    } as unknown as SkillCatalogService;

    const plan = ActOrchestrator.prepare('go ahead', {
      hasActivePlan: true,
      savedPlanId: 'plan-123',
      skillCatalog,
      verifyCommands: ['npm test'],
      taskAnalysis: analyzeTask('fix the failing test in src/core/foo.ts', 'agent'),
    });

    expect(plan.executionPath).toBe('resume_saved_plan');
    expect(plan.savedPlanId).toBe('plan-123');
    expect(plan.verifyCommands).toEqual(['npm test']);
    expect(plan.promptContext).toContain('Saved plan handoff');
    expect(plan.promptContext).toContain('plan-123');
    expect(plan.appliedSkills).toContain('debugging-and-error-recovery');
  });

  it('honors deep Act depth as a 16-step execution budget', () => {
    const plan = ActOrchestrator.prepare('Implement the new settings flow', {
      actDepth: 'deep',
      configuredMaxSteps: 100,
      taskAnalysis: analyzeTask('Implement the new settings flow', 'agent'),
    });

    expect(plan.maxSteps).toBe(16);
  });

  it('includes configured verification commands in the Act prompt contract', () => {
    const plan = ActOrchestrator.prepare('Fix the failing build', {
      verifyCommands: ['npm test', 'npm run lint'],
      taskAnalysis: analyzeTask('Fix the failing build', 'agent'),
    });

    expect(plan.promptContext).toContain('## Verification commands');
    expect(plan.promptContext).toContain('- npm test');
    expect(plan.promptContext).toContain('- npm run lint');
  });

  it('adds ACT skill tool guidance to Agent system prompts when tools are enabled', () => {
    const prompt = buildSystemPrompt('agent', true);
    expect(prompt).toContain('ACT SKILLS:');
    expect(prompt).toContain('Call use_skill');
  });

  it('scales retrieved context item count with context window and Act depth', () => {
    expect(resolveMaxContextItems({ contextWindow: 8192 })).toBe(28);
    expect(resolveMaxContextItems({ contextWindow: 256_000, actDepth: 'deep' })).toBeGreaterThan(28);
    expect(resolveMaxContextItems({ contextWindow: 256_000, actDepth: 'deep' })).toBeLessThanOrEqual(80);
  });

  it('filters plan-management tools from direct Act loops', () => {
    const tools = [
      tool('read_file'),
      tool('apply_patch'),
      tool('mcp__filesystem__read_file'),
      tool('mcp__filesystem__write_file'),
      tool('mcp__filesystem__move_file'),
      tool('mark_step_complete'),
      tool('propose_plan_mutation'),
    ];

    expect(filterActModeTools(tools).map((item) => item.function.name)).toEqual([
      'read_file',
      'apply_patch',
      'mcp__filesystem__read_file',
    ]);
  });
});

function tool(name: string): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description: name,
      parameters: {},
    },
  };
}
