import { describe, it, expect } from 'vitest';
import { IgnoreService } from '../src/core/indexing/IgnoreService';
import { ChunkingService } from '../src/core/indexing/ChunkingService';
import { sanitizeFtsQuery } from '../src/core/indexing/FtsIndex';
import { tsExtractor, pythonExtractor } from '../src/core/indexing/SymbolExtractor';
import { isDangerousCommand } from '../src/core/safety/ToolPolicyEngine';
import { ToolPolicyEngine } from '../src/core/safety/ToolPolicyEngine';
import { ContextBudgeter } from '../src/core/context/ContextBudgeter';
import type { ContextItem } from '../src/core/context/types';
import { defaultThunderConfig } from '../src/core/config/schema';
import { estimateTokens } from '../src/core/llm/tokenEstimate';

describe('IgnoreService', () => {
  it('ignores node_modules by default', () => {
    const ig = new IgnoreService();
    ig.load('/tmp');
    expect(ig.isIgnored('node_modules/foo/bar.js')).toBe(true);
    expect(ig.isIgnored('src/index.ts')).toBe(false);
  });
});

describe('ChunkingService', () => {
  it('chunks typescript by function boundaries', () => {
    const chunker = new ChunkingService();
    const content = `function foo() {\n  return 1;\n}\n\nfunction bar() {\n  return 2;\n}`;
    const chunks = chunker.chunkFile(content, 'typescript');
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('fallback chunks large files', () => {
    const chunker = new ChunkingService();
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i}`);
    const chunks = chunker.chunkFile(lines.join('\n'), null);
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe('SymbolExtractor', () => {
  it('extracts TS symbols', () => {
    const content = 'export class Foo {}\nexport function bar() {}';
    const symbols = tsExtractor.extract(content);
    expect(symbols.some((s) => s.name === 'Foo')).toBe(true);
    expect(symbols.some((s) => s.name === 'bar')).toBe(true);
  });

  it('extracts Python symbols', () => {
    const content = 'class MyClass:\n    pass\ndef my_func():\n    pass';
    const symbols = pythonExtractor.extract(content);
    expect(symbols.some((s) => s.name === 'MyClass')).toBe(true);
    expect(symbols.some((s) => s.name === 'my_func')).toBe(true);
  });
});

describe('FTS query sanitizer', () => {
  it('sanitizes queries', () => {
    const result = sanitizeFtsQuery('hello world!');
    expect(result).toContain('"hello"');
    expect(result).toContain('"world"');
  });

  it('returns empty for short query', () => {
    expect(sanitizeFtsQuery('a')).toBe('');
  });
});

describe('ToolPolicyEngine', () => {
  const engine = new ToolPolicyEngine(
    defaultThunderConfig().safety,
    () => false
  );

  it('allows read-only tools', () => {
    expect(engine.evaluate('read_file', { path: 'src/index.ts' }).decision).toBe('allow');
  });

  it('requires approval for writes', () => {
    expect(engine.evaluate('write_file', { path: 'src/index.ts' }).decision).toBe('require_approval');
  });

  it('blocks dangerous commands', () => {
    expect(isDangerousCommand('rm -rf /')).toBe(true);
    expect(isDangerousCommand('npm test')).toBe(false);
  });
});

describe('ContextBudgeter', () => {
  it('budgets context items', () => {
    const budgeter = new ContextBudgeter();
    const items: ContextItem[] = [
      { id: '1', source: 'fts', content: 'a'.repeat(400), score: 5, reason: 'test', tokenEstimate: 100 },
      { id: '2', source: 'repo-map', content: 'b'.repeat(400), score: 3, reason: 'test', tokenEstimate: 100 },
    ];
    const pack = budgeter.budget(items, 150);
    expect(pack.items.length).toBeLessThanOrEqual(2);
    expect(pack.totalTokens).toBeLessThanOrEqual(150);
  });

  it('truncates oversized repo maps instead of dropping them', () => {
    const budgeter = new ContextBudgeter();
    const items: ContextItem[] = [
      { id: 'repo', source: 'repo-map', content: 'src/index.ts\n'.repeat(500), score: 7, reason: 'repo map', tokenEstimate: 1500 },
    ];
    const pack = budgeter.budget(items, 300);
    expect(pack.items).toHaveLength(1);
    expect(pack.items[0].source).toBe('repo-map');
    expect(pack.items[0].content).toContain('[truncated]');
    expect(pack.totalTokens).toBeLessThanOrEqual(300);
  });

  it('includes workspace overview context', () => {
    const budgeter = new ContextBudgeter();
    const items: ContextItem[] = [
      { id: 'overview', source: 'workspace-overview', content: 'README\npackage.json', score: 9, reason: 'overview', tokenEstimate: 5 },
    ];
    const pack = budgeter.budget(items, 100);
    expect(pack.items).toHaveLength(1);
    expect(pack.formatted).toContain('README');
  });
});

describe('Token estimate', () => {
  it('estimates tokens', () => {
    expect(estimateTokens('hello world')).toBeGreaterThan(0);
  });
});

describe('Config schema', () => {
  it('parses defaults', () => {
    const config = defaultThunderConfig();
    expect(config.provider.type).toBe('echo');
    expect(config.indexing.enabled).toBe(true);
  });
});

describe('extractFileMentions', () => {
  it('extracts file names from user text', async () => {
    const { extractFileMentions } = await import('../src/core/context/fuzzyFileMatch');
    const mentions = extractFileMentions('Can you change DineInKanban.tsx and src/App.tsx?');
    expect(mentions).toContain('DineInKanban.tsx');
    expect(mentions).toContain('src/App.tsx');
  });
});

describe('fuzzyFileMatch', () => {
  it('expands DinInKanban to searchable kanban term', async () => {
    const { expandCamelCaseTerms, globPatternsForMention } = await import('../src/core/context/fuzzyFileMatch');
    const terms = expandCamelCaseTerms('DinInKanban.tsx');
    expect(terms).toContain('kanban');
    const patterns = globPatternsForMention('DinInKanban.tsx');
    expect(patterns.some((p) => p.includes('kanban'))).toBe(true);
  });
});

describe('ApprovalQueue', () => {
  it('stores full input for large write_file payloads', async () => {
    const { ApprovalQueue } = await import('../src/core/safety/ApprovalQueue');
    const queue = new ApprovalQueue();
    const bigContent = 'x'.repeat(20_000);
    const req = queue.createRequest('s1', 'write_file', { path: 'src/Foo.tsx', content: bigContent }, {
      decision: 'require_approval',
      reason: 'test',
    });
    expect(req.inputPreview).toContain('20,000');
    expect(req.contentLength).toBe(20_000);
    const full = queue.getFullInput(req.id);
    expect(full?.content).toBe(bigContent);
  });
});

describe('codeEditParser', () => {
  it('parses CODE_EDIT_BLOCK format', async () => {
    const { parseCodeEdits } = await import('../src/core/apply/codeEditParser');
    const response = 'Here is the file:\n```tsx|CODE_EDIT_BLOCK|src/Foo.tsx\nexport const x = 1\n```';
    const edits = parseCodeEdits(response);
    expect(edits).toHaveLength(1);
    expect(edits[0].path).toBe('src/Foo.tsx');
    expect(edits[0].content).toContain('export const x');
  });

  it('infers path from user mention when one code block', async () => {
    const { parseCodeEdits } = await import('../src/core/apply/codeEditParser');
    const response = '```tsx\nexport const DineInKanban = () => null\n```';
    const edits = parseCodeEdits(response, 'redesign DineInKanban.tsx');
    expect(edits[0]?.path).toBe('DineInKanban.tsx');
  });
});

describe('ContextCompaction', () => {
  it('keeps recent messages within budget', async () => {
    const { compactMessages } = await import('../src/core/agent/ContextCompaction');
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: 'user' as const,
      content: `message ${i} `.repeat(50),
    }));
    const compacted = compactMessages(messages, 200);
    expect(compacted.length).toBeLessThanOrEqual(messages.length);
  });
});

describe('autonomyPresets', () => {
  it('pilot preset auto-approves writes', async () => {
    const { applyAutonomyPreset } = await import('../src/core/safety/autonomyPresets');
    const base = defaultThunderConfig().safety;
    const pilot = applyAutonomyPreset(base, 'pilot');
    expect(pilot.requireApprovalForWrites).toBe(false);
    expect(pilot.requireApprovalForShell).toBe(true);
  });
});

describe('shouldDecomposeTask', () => {
  it('only decomposes when user explicitly asks for a plan', async () => {
    const { shouldDecomposeTask } = await import('../src/core/agent/PlanExecutor');
    expect(
      shouldDecomposeTask('implement auth and then add tests step by step for all routes', 'act')
    ).toBe(true);
    expect(shouldDecomposeTask('implement auth and then add tests for all routes', 'act')).toBe(false);
    expect(
      shouldDecomposeTask('identify and remove unused files and dependencies in the whole project', 'act')
    ).toBe(false);
    expect(shouldDecomposeTask('implement auth and then add tests', 'plan')).toBe(false);
    expect(shouldDecomposeTask('hi', 'act')).toBe(false);
  });
});

describe('contextRelevance', () => {
  it('includes diagnostics only for error-fix requests', async () => {
    const { isDiagnosticsRelevant } = await import('../src/core/context/contextRelevance');
    expect(isDiagnosticsRelevant('fix the type errors in auth.ts')).toBe(true);
    expect(isDiagnosticsRelevant('list unused files and dependencies')).toBe(false);
  });

  it('skips passive editor context unless the file is mentioned', async () => {
    const { isFileContextRelevant } = await import('../src/core/context/contextRelevance');
    expect(isFileContextRelevant('clean up unused deps', 'src/screens/DineInKanban.tsx')).toBe(false);
    expect(isFileContextRelevant('fix DineInKanban.tsx imports', 'src/screens/DineInKanban.tsx')).toBe(true);
  });
});

describe('taskKind', () => {
  it('detects audit/cleanup tasks', async () => {
    const { isAuditCleanupTask } = await import('../src/core/agent/taskKind');
    expect(isAuditCleanupTask('identify and remove unused files and dependencies')).toBe(true);
    expect(isAuditCleanupTask('what does this project do?')).toBe(false);
  });
});

describe('PlanActEngine read-only shell', () => {
  it('allows inspection commands in plan mode', async () => {
    const { isShellAllowed, isReadOnlyCommand } = await import('../src/core/planning/PlanActEngine');
    expect(isReadOnlyCommand('npx depcheck')).toBe(true);
    expect(isShellAllowed('plan', 'npx depcheck')).toBe(true);
    expect(isShellAllowed('plan', 'npm install lodash')).toBe(false);
  });
});

describe('pathUtils', () => {
  it('normalizes "." to empty root', async () => {
    const { normalizeRelPath } = await import('../src/core/vscode/pathUtils');
    expect(normalizeRelPath('.')).toBe('');
    expect(normalizeRelPath('./src/foo.ts')).toBe('src/foo.ts');
  });

  it('rejects invalid workspace roots', async () => {
    const { normalizeWorkspaceRoot } = await import('../src/core/vscode/pathUtils');
    expect(normalizeWorkspaceRoot('')).toBeNull();
    expect(normalizeWorkspaceRoot('   ')).toBeNull();
    expect(normalizeWorkspaceRoot('/tmp')).toMatch(/tmp/);
  });
});

describe('pageRank', () => {
  it('ranks highly referenced nodes higher', async () => {
    const { computePageRank } = await import('../src/core/context/pageRank');
    const scores = computePageRank(
      ['a.ts', 'b.ts', 'c.ts'],
      [
        { from: 'b.ts', to: 'a.ts' },
        { from: 'c.ts', to: 'a.ts' },
        { from: 'a.ts', to: 'b.ts' },
      ]
    );
    expect((scores.get('a.ts') ?? 0)).toBeGreaterThan(scores.get('c.ts') ?? 0);
  });
});

describe('PassiveMemoryInjector', () => {
  it('returns empty without memory service', async () => {
    const { PassiveMemoryInjector } = await import('../src/core/memory/PassiveMemoryInjector');
    const injector = new PassiveMemoryInjector(undefined);
    expect(injector.inject('auth module')).toEqual([]);
  });
});

describe('PatchApplyService validateSyntax', () => {
  it('rejects invalid JSON', async () => {
    const { PatchApplyService } = await import('../src/core/apply/PatchApplyService');
    const svc = new PatchApplyService('/tmp');
    const result = svc.validateSyntax('data.json', '{ invalid');
    expect(result.success).toBe(false);
  });
});

describe('HashEmbeddingProvider', () => {
  it('produces normalized embeddings', async () => {
    const { HashEmbeddingProvider, cosineSimilarity } = await import('../src/core/indexing/EmbeddingProvider');
    const provider = new HashEmbeddingProvider();
    const [a, b] = await provider.embed(['hello world', 'hello there']);
    expect(a.length).toBeGreaterThan(0);
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0);
  });
});

describe('SubagentTracker', () => {
  it('tracks run lifecycle', async () => {
    const { SubagentTracker } = await import('../src/core/agent/SubagentTracker');
    const tracker = new SubagentTracker();
    const updates: number[] = [];
    tracker.setUpdateCallback((runs) => updates.push(runs.length));
    const id = tracker.start('find unused deps');
    tracker.finish(id, 'found 3 unused packages');
    expect(tracker.getRuns()[0]?.status).toBe('done');
    expect(updates.length).toBeGreaterThan(0);
  });
});

describe('toolSchema', () => {
  it('converts zod tool to OpenAI definition', async () => {
    const { z } = await import('zod');
    const { toolToDefinition } = await import('../src/core/tools/toolSchema');
    const def = toolToDefinition({
      name: 'read_file',
      description: 'Read a file',
      risk: 'low',
      inputSchema: z.object({ path: z.string() }),
      execute: async () => ({ success: true, output: '' }),
    });
    expect(def.function.name).toBe('read_file');
    expect(def.function.parameters).toHaveProperty('properties');
  });
});
