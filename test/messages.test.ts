import { describe, it, expect } from 'vitest';
import { initialWebviewState, defaultContextToggles } from '../src/vscode/webview/messages';

describe('Webview message protocol', () => {
  it('has valid initial state', () => {
    const state = initialWebviewState();
    expect(state.tab).toBe('chat');
    expect(state.mode).toBe('plan');
    expect(state.messages).toHaveLength(0);
    expect(state.approvals).toHaveLength(0);
    expect(state.indexing.running).toBe(false);
  });

  it('has default context toggles with diagnostics off by default', () => {
    const toggles = defaultContextToggles();
    expect(toggles.repoMap).toBe(true);
    expect(toggles.fts).toBe(true);
    expect(toggles.gitDiff).toBe(true);
    expect(toggles.diagnostics).toBe(false);
    expect(toggles.memory).toBe(true);
  });
});

describe('ToolExecutor', () => {
  it('blocks writes in plan mode', async () => {
    const { ToolExecutor } = await import('../src/core/safety/ToolExecutor');
    const { ToolRuntime } = await import('../src/core/tools/ToolRuntime');
    const { ToolPolicyEngine } = await import('../src/core/safety/ToolPolicyEngine');
    const { ApprovalQueue } = await import('../src/core/safety/ApprovalQueue');
    const { defaultThunderConfig } = await import('../src/core/config/schema');
    const { createWriteFileTool } = await import('../src/core/tools/builtinTools');
    const { IgnoreService } = await import('../src/core/indexing/IgnoreService');

    const runtime = new ToolRuntime();
    runtime.register(createWriteFileTool(process.cwd(), new IgnoreService()));

    const executor = new ToolExecutor(
      runtime,
      new ToolPolicyEngine(defaultThunderConfig().safety, () => false),
      new ApprovalQueue(),
      () => 'session-1',
      () => 'plan'
    );

    const result = await executor.execute('write_file', { path: 'test.ts', content: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Plan');
  });
});
