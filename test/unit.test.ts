import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { IgnoreService } from '../src/core/indexing/IgnoreService';
import { ChunkingService } from '../src/core/indexing/ChunkingService';
import { sanitizeFtsQuery } from '../src/core/indexing/FtsIndex';
import { tsExtractor, pythonExtractor, extractSymbols } from '../src/core/indexing/SymbolExtractor';
import {
  detectLanguageFromPath,
  getSupportedExtensionCount,
  getWasmLanguageIds,
  hasWasmGrammar,
} from '../src/core/indexing/languageRegistry';
import { detectLanguage } from '../src/core/indexing/fileUtils';
import { isDangerousCommand, isDeleteLikeCommand } from '../src/core/safety/ToolPolicyEngine';
import { ToolPolicyEngine } from '../src/core/safety/ToolPolicyEngine';
import { ContextBudgeter } from '../src/core/context/ContextBudgeter';
import type { ContextItem } from '../src/core/context/types';
import { defaultThunderConfig } from '../src/core/config/schema';
import { estimateTokens } from '../src/core/llm/tokenEstimate';
import { UsageTrackingProvider } from '../src/core/llm/UsageTrackingProvider';
import { ProjectRulesService } from '../src/core/rules/ProjectRulesService';

describe('IgnoreService', () => {
  it('ignores node_modules by default', () => {
    const ig = new IgnoreService();
    ig.load('/tmp');
    expect(ig.isIgnored('node_modules/foo/bar.js')).toBe(true);
    expect(ig.isIgnored('src/index.ts')).toBe(false);
  });

  it('accepts root and dot-prefixed relative paths', () => {
    const ig = new IgnoreService();
    ig.load('/tmp');
    expect(ig.isIgnored('.')).toBe(false);
    expect(ig.isIgnored('./src/index.ts')).toBe(false);
    expect(ig.isIgnored('./node_modules/pkg/index.js')).toBe(true);
  });

  it('normalizes absolute workspace paths before ignore checks', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-ignore-absolute-test-'));
    try {
      const ig = new IgnoreService();
      ig.load(tempDir);
      expect(ig.isIgnored(join(tempDir, 'package.json'))).toBe(false);
      expect(ig.isIgnored(join(tempDir, 'node_modules/pkg/index.js'))).toBe(true);
      expect(ig.isIgnored(join(tmpdir(), 'outside.ts'))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('lists workspace root when path is "."', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-list-root-test-'));
    try {
      writeFileSync(join(tempDir, 'package.json'), '{}');
      mkdirSync(join(tempDir, 'node_modules'));
      const ig = new IgnoreService();
      ig.load(tempDir);
      const { createListFilesTool } = await import('../src/core/tools/builtinTools');
      const result = await createListFilesTool(tempDir, ig).execute({ path: '.', recursive: false });
      expect(result.success).toBe(true);
      expect(result.output).toContain('package.json');
      expect(result.output).not.toContain('node_modules');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses to write shell commands into source files', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-write-guard-test-'));
    try {
      const ig = new IgnoreService();
      ig.load(tempDir);
      const { createWriteFileTool } = await import('../src/core/tools/builtinTools');
      const result = await createWriteFileTool(tempDir, ig).execute({
        path: 'src/screens/kitchen-screen/components/DineInKanban.tsx',
        content: 'git checkout HEAD -- src/screens/kitchen-screen/components/DineInKanban.tsx',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('content starts with a shell command');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
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

  it('extracts Rust symbols via regex fallback', () => {
    const content = 'pub fn hello() {}\npub struct World;\npub enum Color { Red }';
    const symbols = extractSymbols(content, 'rust');
    expect(symbols.some((s) => s.name === 'hello')).toBe(true);
    expect(symbols.some((s) => s.name === 'World')).toBe(true);
    expect(symbols.some((s) => s.name === 'Color')).toBe(true);
  });

  it('extracts Ruby symbols via regex fallback', () => {
    const content = 'class User\n  def greet\n  end\nend';
    const symbols = extractSymbols(content, 'ruby');
    expect(symbols.some((s) => s.name === 'User')).toBe(true);
    expect(symbols.some((s) => s.name === 'greet')).toBe(true);
  });

  it('extracts Haskell symbols via regex fallback', () => {
    const content = 'data Tree a = Leaf | Node a (Tree a)\nmyFunc :: Int -> Int';
    const symbols = extractSymbols(content, 'haskell');
    expect(symbols.some((s) => s.name === 'Tree')).toBe(true);
    expect(symbols.some((s) => s.name === 'myFunc')).toBe(true);
  });
});

describe('languageRegistry', () => {
  it('supports 100+ file extensions', () => {
    expect(getSupportedExtensionCount()).toBeGreaterThanOrEqual(100);
  });

  it('detects common and niche languages', () => {
    expect(detectLanguageFromPath('src/main.rs')).toBe('rust');
    expect(detectLanguageFromPath('lib/kotlin/App.kt')).toBe('kotlin');
    expect(detectLanguageFromPath('contracts/token.sol')).toBe('solidity');
    expect(detectLanguageFromPath('schema/query.sql')).toBe('sql');
    expect(detectLanguageFromPath('infra/main.tf')).toBe('hcl');
    expect(detectLanguage('Dockerfile')).toBe('dockerfile');
  });

  it('maps tree-sitter WASM grammars for key languages', () => {
    const wasmLangs = getWasmLanguageIds();
    expect(wasmLangs).toContain('typescript');
    expect(wasmLangs).toContain('rust');
    expect(wasmLangs).toContain('swift');
    expect(wasmLangs.length).toBeGreaterThanOrEqual(30);
    expect(hasWasmGrammar('rust')).toBe(true);
    expect(hasWasmGrammar('haskell')).toBe(false);
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

  it('requires approval for shell commands when shell approval is enabled', () => {
    expect(engine.evaluate('run_command', { command: 'rg "DineInKanban" src' }).decision).toBe('allow');
    expect(engine.evaluate('run_command', { command: 'npx depcheck' }).decision).toBe('allow');
    expect(engine.evaluate('run_command', { command: 'npm install lodash' }).decision).toBe('require_approval');
  });

  it('supports ask-before-delete approval mode', () => {
    const deleteEngine = new ToolPolicyEngine(
      { ...defaultThunderConfig().safety, approvalMode: 'ask_deletes' },
      () => false
    );

    expect(deleteEngine.evaluate('write_file', { path: 'src/index.ts', content: 'x' }).decision).toBe('allow');
    expect(deleteEngine.evaluate('run_command', { command: 'npm install lodash' }).decision).toBe('allow');
    expect(deleteEngine.evaluate('run_command', { command: 'npm uninstall lodash' }).decision).toBe('require_approval');
    expect(deleteEngine.evaluate('run_command', { command: 'rm src/old.ts' }).decision).toBe('require_approval');
  });

  it('supports ask-before-edit and auto approval modes', () => {
    const editEngine = new ToolPolicyEngine(
      { ...defaultThunderConfig().safety, approvalMode: 'ask_edits' },
      () => false
    );
    const autoEngine = new ToolPolicyEngine(
      { ...defaultThunderConfig().safety, approvalMode: 'auto' },
      () => false
    );

    expect(editEngine.evaluate('write_file', { path: 'src/index.ts', content: 'x' }).decision).toBe('require_approval');
    expect(editEngine.evaluate('run_command', { command: 'npm install lodash' }).decision).toBe('allow');
    expect(autoEngine.evaluate('write_file', { path: 'src/index.ts', content: 'x' }).decision).toBe('allow');
    expect(autoEngine.evaluate('run_command', { command: 'npm install lodash' }).decision).toBe('allow');
  });

  it('blocks dangerous commands', () => {
    expect(isDangerousCommand('rm -rf /')).toBe(true);
    expect(isDangerousCommand('npm test')).toBe(false);
  });

  it('detects delete-like commands', () => {
    expect(isDeleteLikeCommand('git rm src/old.ts')).toBe(true);
    expect(isDeleteLikeCommand('pnpm remove unused-package')).toBe(true);
    expect(isDeleteLikeCommand('npm install lodash')).toBe(false);
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

  it('tracks each provider completion as estimated AI usage', async () => {
    const records: Array<{ inputTokens: number; outputTokens: number; totalTokens: number }> = [];
    const provider = new UsageTrackingProvider({
      id: 'fake',
      capabilities: {
        contextWindow: 8192,
        supportsStreaming: true,
        supportsTools: true,
        supportsEmbeddings: false,
      },
      async *complete() {
        yield { content: 'hello ' };
        yield { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] };
        yield { content: 'world' };
        yield { done: true };
      },
    }, (usage) => records.push(usage));

    for await (const _ of provider.complete({
      messages: [{ role: 'user', content: 'inspect the file' }],
      tools: [{
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: {} },
        },
      }],
      stream: true,
    })) {
      // Drain the stream.
    }

    expect(records).toHaveLength(1);
    expect(records[0].inputTokens).toBeGreaterThan(0);
    expect(records[0].outputTokens).toBeGreaterThan(0);
    expect(records[0].totalTokens).toBe(records[0].inputTokens + records[0].outputTokens);
  });
});

describe('Thunder config', () => {
  it('defaults MCP bulk startup concurrency', () => {
    expect(defaultThunderConfig().mcp.maxConcurrentStartup).toBe(4);
  });

  it('preloads built-in MCP servers by default', () => {
    expect(defaultThunderConfig().mcp.preloadBuiltin).toBe(true);
  });
});

describe('Builtin MCP servers', () => {
  it('builds free official servers for a workspace', async () => {
    const { buildBuiltinMcpServers } = await import('../src/core/mcp/builtinServers');
    const servers = buildBuiltinMcpServers('/tmp/my-project');

    expect(Object.keys(servers).sort()).toEqual(['filesystem', 'memory', 'sequential-thinking']);
    expect(servers.filesystem.command).toBe(process.platform === 'win32' ? 'cmd' : 'npx');
    expect(servers.filesystem.args).toContain('@modelcontextprotocol/server-filesystem');
    expect(servers.filesystem.args.at(-1)).toBe(resolve('/tmp/my-project'));
    expect(servers.memory.args).toContain('@modelcontextprotocol/server-memory');
    expect(servers['sequential-thinking'].args).toContain('@modelcontextprotocol/server-sequential-thinking');
  });

  it('omits filesystem when workspace is empty', async () => {
    const { buildBuiltinMcpServers } = await import('../src/core/mcp/builtinServers');
    const servers = buildBuiltinMcpServers('');
    expect(Object.keys(servers).sort()).toEqual(['memory', 'sequential-thinking']);
  });

  it('lets user settings override built-in servers', async () => {
    const { resolveMcpServers } = await import('../src/core/mcp/McpManager');
    const config = defaultThunderConfig();
    const servers = resolveMcpServers(
      {
        ...config.mcp,
        servers: {
          memory: {
            disabled: true,
            type: 'stdio',
            command: 'custom',
            args: ['memory'],
            env: {},
            timeoutMs: 60_000,
          },
        },
      },
      '/tmp/project'
    );

    expect(servers.memory.command).toBe('custom');
    expect(servers.filesystem.command).toBe(process.platform === 'win32' ? 'cmd' : 'npx');
  });

  it('skips built-ins when preloadBuiltin is false', async () => {
    const { resolveMcpServers } = await import('../src/core/mcp/McpManager');
    const config = defaultThunderConfig();
    const servers = resolveMcpServers({ ...config.mcp, preloadBuiltin: false }, '/tmp/project');
    expect(servers).toEqual({});
  });
});

describe('ProjectRulesService', () => {
  it('loads common root-level agent rule files', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-rules-test-'));
    try {
      writeFileSync(join(tempDir, 'AGENTS.md'), 'agent instructions');
      writeFileSync(join(tempDir, 'CLAUDE.md'), 'claude instructions');
      writeFileSync(join(tempDir, '.cursorrules'), 'cursor instructions');
      writeFileSync(join(tempDir, '.clinerules'), 'cline instructions');

      const rules = new ProjectRulesService(tempDir).load();
      expect(rules.map((rule) => rule.relPath)).toEqual([
        'AGENTS.md',
        'CLAUDE.md',
        '.cursorrules',
        '.clinerules',
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('loads markdown files from Mitii rule, agent, check, and prompt folders', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-rules-test-'));
    try {
      for (const relDir of ['.mitii/rules', '.mitii/agents', '.mitii/checks', '.mitii/prompts']) {
        mkdirSync(join(tempDir, relDir), { recursive: true });
        writeFileSync(join(tempDir, relDir, 'methodology.md'), `${relDir} instructions`);
      }

      const rules = new ProjectRulesService(tempDir).load();
      expect(rules.map((rule) => rule.relPath)).toEqual([
        '.mitii/rules/methodology.md',
        '.mitii/agents/methodology.md',
        '.mitii/checks/methodology.md',
        '.mitii/prompts/methodology.md',
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('Config schema', () => {
  it('parses defaults', () => {
    const config = defaultThunderConfig();
    expect(config.provider.type).toBe('echo');
    expect(config.indexing.enabled).toBe(true);
  });
});

describe('Plan/Act task analysis', () => {
  it('plans actionable requests in plan mode without marking them for execution verification', async () => {
    const { analyzeTask } = await import('../src/core/agent/TaskAnalyzer');
    const analysis = analyzeTask('Implement a solid planning mode and separate act mode', 'plan');

    expect(analysis.kind).toBe('implementation');
    expect(analysis.shouldPlan).toBe(true);
    expect(analysis.shouldVerify).toBe(false);
    expect(analysis.summary).toContain('Plan mode');
  });

  it('plans and verifies actionable requests in act mode', async () => {
    const { analyzeTask } = await import('../src/core/agent/TaskAnalyzer');
    const analysis = analyzeTask('Implement a solid planning mode and separate act mode', 'act');

    expect(analysis.kind).toBe('implementation');
    expect(analysis.shouldPlan).toBe(true);
    expect(analysis.shouldVerify).toBe(true);
  });
});

describe('Plan parser', () => {
  it('flattens rich phase plans into executable steps', async () => {
    const { parsePlanFromText } = await import('../src/core/planning/PlanActEngine');
    const parsed = parsePlanFromText(`\`\`\`json
{
  "goal": "Improve planning",
  "assumptions": [],
  "phases": [
    {
      "id": "phase-1",
      "title": "Phase 1: Diagnostics",
      "phase": "diagnostics",
      "objective": "Inspect current behavior",
      "steps": [
        {
          "id": "step-1",
          "title": "Inspect mode routing",
          "tools": ["read_file"],
          "successCriteria": ["Mode branch is understood"],
          "files": ["src/core/ChatOrchestrator.ts"],
          "risk": "low"
        }
      ]
    }
  ],
  "requiredApprovals": []
}
\`\`\``);

    expect(parsed?.steps).toHaveLength(1);
    expect(parsed?.steps[0].phase).toBe('diagnostics');
    expect(parsed?.steps[0].objective).toBe('Inspect current behavior');
    expect(parsed?.steps[0].tools).toEqual(['read_file']);
    expect(parsed?.steps[0].successCriteria).toEqual(['Mode branch is understood']);
  });

  it('keeps generated plan phases mode-aware', async () => {
    const { PlanExecutor } = await import('../src/core/agent/PlanExecutor');
    const provider = {
      id: 'fake',
      capabilities: {
        contextWindow: 8192,
        supportsStreaming: false,
        supportsTools: false,
        supportsEmbeddings: false,
      },
      async *complete() {
        yield {
          content: `\`\`\`json
{
  "goal": "Fix bug",
  "assumptions": [],
  "steps": [
    {
      "id": "step-1",
      "title": "Fix Theme Utilities",
      "phase": "diagnostics",
      "tools": ["apply_patch"],
      "risk": "medium"
    }
  ],
  "requiredApprovals": []
}
\`\`\``,
        };
      },
    };
    const pack = {
      items: [],
      totalTokens: 0,
      formatted: '',
      budgetLimit: 100,
      retrievedCount: 0,
      truncatedCount: 0,
      dropped: [],
    };
    const executor = new PlanExecutor({} as never, { save: () => 'plan-id' } as never);

    const planMode = await executor.generatePlan(provider, 'plan', pack, 'fix bug');
    const actMode = await executor.generatePlan(provider, 'act', pack, 'fix bug');

    expect(planMode?.steps[0].phase).toBe('diagnostics');
    expect(actMode?.steps[0].phase).toBe('execute');
  });

  it('fails an explicit scripted plan step when its command fails', async () => {
    const { PlanExecutor } = await import('../src/core/agent/PlanExecutor');
    const plan = {
      goal: 'Verify package',
      assumptions: [],
      requiredApprovals: [],
      steps: [
        {
          id: 'verify',
          title: 'Verify Compilation',
          status: 'pending' as const,
          risk: 'low' as const,
          phase: 'verify' as const,
          script: { command: 'npm run lint' },
        },
      ],
    };
    const persistence = {
      save: () => 'plan-id',
      updatePlan: () => undefined,
      complete: () => undefined,
    };
    const agentLoop = {
      hadPendingApproval: () => false,
      async *run() {
        throw new Error('agent loop should not run for explicit scripted steps');
      },
    };
    const toolExecutor = {
      execute: async () => ({ success: false, output: '', error: 'lint failed' }),
    };
    const executor = new PlanExecutor(agentLoop as never, persistence as never, undefined, toolExecutor as never);
    const pack = {
      items: [],
      totalTokens: 0,
      formatted: '',
      budgetLimit: 100,
      retrievedCount: 0,
      truncatedCount: 0,
      dropped: [],
    };
    let output = '';

    for await (const chunk of executor.executePlan(
      { id: 's1', mode: 'act' } as never,
      {} as never,
      plan,
      pack,
      [],
      undefined,
      undefined,
      undefined,
      { stepMaxRetries: 0 }
    )) {
      output += chunk;
    }

    expect(plan.steps[0].status).toBe('failed');
    expect(output).toContain('lint failed');
  });

  it('does not reuse stale agent-loop approval state after an explicit step succeeds', async () => {
    const { PlanExecutor } = await import('../src/core/agent/PlanExecutor');
    const plan = {
      goal: 'Verify package',
      assumptions: [],
      requiredApprovals: [],
      steps: [
        {
          id: 'verify',
          title: 'Verify Compilation',
          status: 'pending' as const,
          risk: 'low' as const,
          phase: 'verify' as const,
          script: { command: 'npm run lint' },
        },
      ],
    };
    let completed = false;
    const persistence = {
      save: () => 'plan-id',
      updatePlan: () => undefined,
      complete: () => { completed = true; },
    };
    const agentLoop = {
      hadPendingApproval: () => true,
      async *run() {
        throw new Error('agent loop should not run for explicit scripted steps');
      },
    };
    const toolExecutor = {
      execute: async () => ({ success: true, output: 'lint ok' }),
    };
    const executor = new PlanExecutor(agentLoop as never, persistence as never, undefined, toolExecutor as never);
    const pack = {
      items: [],
      totalTokens: 0,
      formatted: '',
      budgetLimit: 100,
      retrievedCount: 0,
      truncatedCount: 0,
      dropped: [],
    };

    for await (const _chunk of executor.executePlan(
      { id: 's1', mode: 'act' } as never,
      {} as never,
      plan,
      pack,
      [],
      undefined,
      undefined,
      undefined,
      { stepMaxRetries: 0, finalValidationEnabled: false }
    )) {
      // consume stream
    }

    expect(plan.steps[0].status).toBe('done');
    expect(completed).toBe(true);
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

  it('keeps task approval grants explicit and clearable', async () => {
    const { ApprovalQueue } = await import('../src/core/safety/ApprovalQueue');
    const queue = new ApprovalQueue();
    const req = queue.createRequest('s1', 'write_file', { path: 'src/Foo.tsx', content: 'x' }, {
      decision: 'require_approval',
      reason: 'test',
    });

    queue.resolve(req.id, 'approved');
    expect(queue.hasApprovalGrant('s1', 'write_file')).toBe(false);

    queue.grantForTask('s1', 'write_file');
    expect(queue.hasApprovalGrant('s1', 'write_file')).toBe(true);
    expect(queue.hasApprovalGrant('s1', 'apply_patch')).toBe(false);

    queue.clearTaskGrants('s1');
    expect(queue.hasApprovalGrant('s1', 'write_file')).toBe(false);
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
  it('decomposes implementation tasks and explicit plan requests in act mode', async () => {
    const { shouldDecomposeTask } = await import('../src/core/agent/TaskAnalyzer');
    expect(
      shouldDecomposeTask('implement auth and then add tests step by step for all routes', 'act')
    ).toBe(true);
    expect(shouldDecomposeTask('implement auth and then add tests for all routes', 'act')).toBe(true);
    expect(
      shouldDecomposeTask('identify and remove unused files and dependencies in the whole project', 'act')
    ).toBe(true);
    expect(shouldDecomposeTask('implement auth and then add tests', 'plan')).toBe(true);
    expect(shouldDecomposeTask('hi', 'act')).toBe(false);
    expect(shouldDecomposeTask('what does this project do?', 'act')).toBe(false);
  });
});

describe('TaskAnalyzer', () => {
  it('classifies task kinds', async () => {
    const { analyzeTask } = await import('../src/core/agent/TaskAnalyzer');
    const audit = analyzeTask('find unused dependencies and clean up dead code', 'act');
    expect(audit.kind).toBe('audit');
    expect(audit.shouldPlan).toBe(true);

    const question = analyzeTask('how does authentication work?', 'act');
    expect(question.kind).toBe('question');
    expect(question.shouldPlan).toBe(false);

    const impl = analyzeTask('implement login and then add tests for the auth module', 'act');
    expect(impl.kind).toBe('implementation');
    expect(impl.shouldPlan).toBe(true);
    expect(impl.shouldVerify).toBe(true);
  });

  it('classifies UI polish requests with typos as implementation work', async () => {
    const { analyzeTask } = await import('../src/core/agent/TaskAnalyzer');
    const result = analyzeTask(
      '@src/utils/kitchen-status.ts Can you imporve the Ui and UX of this file and also its child compoenents, cards and all',
      'act'
    );

    expect(result.kind).toBe('implementation');
    expect(result.shouldPlan).toBe(true);
    expect(result.shouldVerify).toBe(true);
  });

  it('treats short product/action trigger words as implementation work', async () => {
    const { analyzeTask } = await import('../src/core/agent/TaskAnalyzer');
    const result = analyzeTask('need animated enterprise landing page UI', 'act');

    expect(result.kind).toBe('implementation');
    expect(result.shouldPlan).toBe(true);
    expect(result.shouldVerify).toBe(true);
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

describe('TaskAnalyzer', () => {
  it('does not re-plan approval continuations', async () => {
    const { analyzeTask } = await import('../src/core/agent/TaskAnalyzer');
    const result = analyzeTask('Continue the current approved task from where it paused.\nOriginal user request: refactor app', 'act');
    expect(result.shouldPlan).toBe(false);
    expect(result.summary).toContain('resume');
  });

  it('classifies cleanup tasks with common typos as audit', async () => {
    const { analyzeTask } = await import('../src/core/agent/TaskAnalyzer');
    const result = analyzeTask(
      'Can you remove all the unsed imports and files and dependencies from the entire porject',
      'act'
    );
    expect(result.kind).toBe('audit');
    expect(result.shouldPlan).toBe(true);
    expect(result.shouldUseSubagents).toBe(false);
  });
});

describe('auditRouting', () => {
  it('detects dependency enumeration subagent tasks', async () => {
    const { isDependencyEnumerationTask, estimateSubagentAuditSeconds, estimateScriptAuditSeconds } =
      await import('../src/core/agent/auditRouting');
    expect(isDependencyEnumerationTask('Check each of the 64 npm dependencies for usage')).toBe(true);
    expect(isDependencyEnumerationTask('Find unused dependencies in package.json')).toBe(true);
    expect(isDependencyEnumerationTask('Map the src folder structure')).toBe(false);
    expect(estimateSubagentAuditSeconds(64)).toBeGreaterThan(60);
    expect(estimateScriptAuditSeconds()).toBeLessThan(10);
  });

  it('blocks spawn_research_agent for dependency audits', async () => {
    const { createSpawnResearchAgentTool } = await import('../src/core/tools/builtinTools');
    const tool = createSpawnResearchAgentTool();
    const result = await tool.execute({
      task: 'Check all unused npm dependencies listed in package.json (18 prod, 46 dev)',
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('audit-dependencies.mjs');
    expect(result.output.toLowerCase()).toContain('subagent blocked');
  });

  it('blocks spawn_research_agent for unused imports audit', async () => {
    const { createSpawnResearchAgentTool } = await import('../src/core/tools/builtinTools');
    const tool = createSpawnResearchAgentTool();
    const result = await tool.execute({
      task: 'Audit unused imports within source files. Look at each .ts file and identify imports never used.',
      focus: 'unused imports within source files',
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('execute_workspace_script');
  });

  it('blocks Audit unused npm dependencies task from log', async () => {
    const { isDependencyEnumerationTask } = await import('../src/core/agent/auditRouting');
    const task =
      'Audit unused npm dependencies in this project. For each dependency in package.json, search whether it is actually imported';
    expect(isDependencyEnumerationTask(task)).toBe(true);
  });
});

describe('shouldUsePlanner', () => {
  it('skips planner for audit tasks in act mode', async () => {
    const { shouldUsePlanner } = await import('../src/core/ChatOrchestrator');
    const { analyzeTask } = await import('../src/core/agent/TaskAnalyzer');
    const analysis = analyzeTask('remove unused imports and dependencies', 'act');
    expect(analysis.kind).toBe('audit');
    expect(shouldUsePlanner('act', analysis, true, true)).toBe(false);
    expect(shouldUsePlanner('act', analysis, true, false)).toBe(true);
    expect(shouldUsePlanner('plan', analysis, true, true)).toBe(true);
  });
});

describe('AgentTaskState', () => {
  it('blocks repeated depcheck after analyze completes', async () => {
    const { AgentTaskState } = await import('../src/core/agent/AgentTaskState');
    const state = new AgentTaskState();
    state.recordToolSuccess('run_command', { command: 'npx depcheck' }, 'Unused: foo');
    expect(state.getPhase()).toBe('execute');
    const blocked = state.checkBlocked('run_command', { command: 'npx depcheck --ignores=x' });
    expect(blocked).toContain('depcheck');
    expect(blocked).toContain('write_file');
  });

  it('allows depcheck again after write_file', async () => {
    const { AgentTaskState } = await import('../src/core/agent/AgentTaskState');
    const state = new AgentTaskState();
    state.recordToolSuccess('run_command', { command: 'npx depcheck' }, 'Unused: foo');
    state.recordToolSuccess('write_file', { path: 'package.json' }, 'Wrote file');
    const blocked = state.checkBlocked('run_command', { command: 'npx depcheck' });
    expect(blocked).toBeNull();
  });

  it('builds pause summary with next step hint', async () => {
    const { AgentTaskState } = await import('../src/core/agent/AgentTaskState');
    const state = new AgentTaskState();
    state.recordToolSuccess('run_command', { command: 'npx depcheck' }, 'Unused dependencies\n* @date-io/dayjs');
    const summary = state.buildPauseSummary('remove unused deps', 'audit');
    expect(summary).toContain('@date-io/dayjs');
    expect(summary).toContain('Next step');
  });

  it('returns soft block with cached eslint output in execute phase', async () => {
    const { AgentTaskState } = await import('../src/core/agent/AgentTaskState');
    const state = new AgentTaskState();
    state.recordToolSuccess('run_command', { command: 'npx eslint src/' }, 'no-unused-vars: 3 errors');
    expect(state.getPhase()).toBe('execute');
    const soft = state.buildSoftBlockResponse('run_command', { command: 'npx eslint src/' });
    expect(soft).toContain('Skipped redundant');
    expect(soft).toContain('no-unused-vars');
    expect(soft).toContain('write_file');
  });
});

describe('tool input coercion', () => {
  it('coerces JSON string arrays for read_files paths', async () => {
    const { normalizeToolInput } = await import('../src/core/tools/coerceInput');
    const { stringArray } = await import('../src/core/tools/coerceInput');
    const schema = stringArray(1, 12);
    const normalized = normalizeToolInput('read_files', {
      paths: '["package.json","src/App.tsx"]',
    });
    const parsed = schema.safeParse((normalized as { paths: unknown }).paths);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual(['package.json', 'src/App.tsx']);
    }
  });

  it('coerces search_batch queries sent as JSON string', async () => {
    const { stringArray } = await import('../src/core/tools/coerceInput');
    const schema = stringArray(1, 10);
    const parsed = schema.safeParse('["@date-io/dayjs","escpos-usb"]');
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toHaveLength(2);
    }
  });
});

describe('PlanActEngine read-only shell', () => {
  it('allows inspection commands in plan mode', async () => {
    const { isShellAllowed, isReadOnlyCommand, isToolAllowedInPlanPhase, stripLeadingCd } = await import('../src/core/planning/PlanActEngine');
    expect(isReadOnlyCommand('npx depcheck')).toBe(true);
    expect(isReadOnlyCommand('cd /home/user && rg "foo" src')).toBe(true);
    expect(isReadOnlyCommand("sed -n '70,90p' src/screens/printer/printer.tsx")).toBe(true);
    expect(isReadOnlyCommand("grep -n 'uuid\\|randomUUID' src/screens/printer/printer.tsx")).toBe(true);
    expect(isReadOnlyCommand('npx tsc --noEmit')).toBe(true);
    expect(isReadOnlyCommand('npm run compile')).toBe(true);
    expect(isReadOnlyCommand('npx vitest run')).toBe(true);
    expect(isReadOnlyCommand('npx vitest')).toBe(false);
    expect(stripLeadingCd('cd /home/user && npm ls')).toBe('npm ls');
    expect(isShellAllowed('plan', 'npx depcheck')).toBe(true);
    expect(isShellAllowed('plan', 'npm install lodash')).toBe(false);
    expect(isToolAllowedInPlanPhase('execute', 'run_command', { command: 'npm run build' }).allowed).toBe(true);
    expect(isToolAllowedInPlanPhase('verify', 'run_command', { command: 'npm run build' }).allowed).toBe(true);
    expect(isToolAllowedInPlanPhase('verify', 'run_command', { command: 'node scripts/custom-mutator.js' }).allowed).toBe(false);
  });

  it('upgrades write-intent steps from diagnostics to execute in act mode', async () => {
    const { resolveStepPhaseLock, stepImpliesWrite } = await import('../src/core/planning/PlanActEngine');
    expect(stepImpliesWrite({ title: 'Audit Current Implementation & Identify Bugs' })).toBe(false);
    expect(stepImpliesWrite({ title: 'Fix ReferenceError & Prepare Theme Utilities' })).toBe(true);
    expect(
      resolveStepPhaseLock(
        { title: 'Fix ReferenceError & Prepare Theme Utilities', phase: 'diagnostics' },
        'act'
      )
    ).toBe('execute');
    expect(
      resolveStepPhaseLock(
        { title: 'Audit Current Implementation & Identify Bugs', phase: 'diagnostics' },
        'act'
      )
    ).toBe('diagnostics');
    expect(stepImpliesWrite({
      title: 'Identify and remove unused imports',
      tools: ['apply_patch'],
    })).toBe(true);
  });

  it('detects phase-lock write errors', async () => {
    const { isPhaseLockWriteError } = await import('../src/core/planning/PlanActEngine');
    expect(isPhaseLockWriteError('Phase 1 (Diagnostics) is read-only; file writes are locked until Phase 3 (Execute).')).toBe(true);
    expect(isPhaseLockWriteError('Patch failed')).toBe(false);
  });

  it('detects phase-lock run_command errors', async () => {
    const { isPhaseLockRunCommandError } = await import('../src/core/planning/PlanActEngine');
    expect(isPhaseLockRunCommandError('Phase 4 (Verify) allows diagnostics, lint, tests, builds, and targeted file fixes, not arbitrary shell commands.')).toBe(true);
    expect(isPhaseLockRunCommandError('Phase 1 (Diagnostics) allows only read-only shell commands.')).toBe(true);
    expect(isPhaseLockRunCommandError('Command exited with code 1')).toBe(false);
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
    expect(await injector.inject('auth module')).toEqual([]);
  });
});

describe('PatchApplyService validateSyntax', () => {
  it('rejects invalid JSON', async () => {
    const { PatchApplyService } = await import('../src/core/apply/PatchApplyService');
    const svc = new PatchApplyService('/tmp');
    const result = svc.validateSyntax('data.json', '{ invalid');
    expect(result.success).toBe(false);
  });

  it('allows targeted TSX patches when the final file has many self-closing components', async () => {
    const { PatchApplyService } = await import('../src/core/apply/PatchApplyService');
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-patch-tsx-test-'));

    try {
      const path = 'Kanban.tsx';
      const oldText = "border: (t) => `1px solid ${t.palette.divider}`";
      const newText = "border: `1px solid ${theme.palette.divider}`";
      const children = Array.from({ length: 16 }, (_, index) => `        <ItemCard key="${index}" />`).join('\n');
      const content = `import React from 'react';

export function Kanban() {
  const theme = { palette: { divider: '#ddd' } };
  return (
    <Box
      sx={{
        ${oldText},
      }}
    >
${children}
    </Box>
  );
}
`;

      writeFileSync(join(tempDir, path), content, 'utf-8');
      const result = new PatchApplyService(tempDir).apply({ path, oldText, newText });

      expect(result.success).toBe(true);
      expect(result.proposedContent).toContain(newText);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
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

describe('ContextReranker', () => {
  it('reranks candidates by lexical overlap', async () => {
    const { LexicalContextReranker } = await import('../src/core/context/ContextReranker');
    const reranker = new LexicalContextReranker();
    const items = [
      { id: 'a', source: 'fts', content: 'unrelated blob', score: 9, reason: 'fts', tokenEstimate: 10 },
      { id: 'b', source: 'fts', content: 'authentication middleware login', score: 5, reason: 'fts', tokenEstimate: 10 },
    ];
    const ranked = await reranker.rerank('authentication login', items, 1);
    expect(ranked[0]?.id).toBe('b');
  });
});

describe('HybridRetriever reranker', () => {
  it('applies reranker top-k when enabled', async () => {
    const { HybridRetriever } = await import('../src/core/context/HybridRetriever');
    const { LexicalContextReranker } = await import('../src/core/context/ContextReranker');
    const retriever = new HybridRetriever(
      [{
        id: 'mock',
        async retrieve() {
          return Array.from({ length: 12 }, (_, i) => ({
            id: `item-${i}`,
            source: 'fts',
            content: i === 3 ? 'target auth token flow' : `noise ${i}`,
            score: 12 - i,
            reason: 'mock',
            tokenEstimate: 5,
          }));
        },
      }],
      new LexicalContextReranker(),
      { enabled: true, candidatePool: 10, topK: 3 }
    );
    const results = await retriever.retrieve({ text: 'auth token', maxItems: 20 });
    expect(results.length).toBe(3);
    expect(results.some((r) => r.content.includes('auth'))).toBe(true);
  });
});

describe('MemoryService FTS', () => {
  it('searches observations via FTS5', async () => {
    const { mkdtempSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const { ThunderDb } = await import('../src/core/indexing/ThunderDb');
    const { MigrationRunner } = await import('../src/core/indexing/migrations');
    const { MemoryService } = await import('../src/core/memory/MemoryService');

    const dir = mkdtempSync(join(tmpdir(), 'thunder-memory-fts-'));
    const db = new ThunderDb(join(dir, 'thunder.sqlite'));
    db.open();
    new MigrationRunner(db).run();

    const memory = new MemoryService(db, 'ws', { maxItems: 10 });
    memory.write('s1', 'decision', 'Use JWT for authentication middleware');
    memory.write('s1', 'bugfix', 'Fixed unrelated pagination bug');

    const hits = memory.search('authentication JWT', 5);
    expect(hits.some((h) => h.text.includes('JWT'))).toBe(true);

    db.close();
    rmSync(dir, { recursive: true, force: true });
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

describe('SessionLogService', () => {
  it('writes JSONL events and builds a summary', async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const { SessionLogService } = await import('../src/core/telemetry/SessionLogService');

    const dir = mkdtempSync(join(tmpdir(), 'thunder-log-'));
    const workspace = join(dir, 'ws');
    const log = new SessionLogService();
    log.configure(workspace, 'sess-1', true);
    log.writeSessionHeader({ mode: 'act' });
    log.append('user_message', 'hello', { mode: 'act' });
    log.append('tool_start', 'read_file', { input: { path: 'package.json' } });

    const path = log.getLogPath();
    expect(path).toContain('.mitii/logs');
    expect(path).toContain('sess-1.jsonl');
    const content = readFileSync(path!, 'utf-8');
    expect(content).toContain('user_message');
    const firstEvent = JSON.parse(content.trim().split('\n')[0]);
    expect(firstEvent.time).toEqual(expect.any(String));
    expect(firstEvent.data.startedAtLocal).toEqual(expect.any(String));
    expect(log.exportSummary()).toContain('sess-1');

    rmSync(dir, { recursive: true, force: true });
  });

  it('records canonical tool start and end fields from ToolRuntime', async () => {
    const { z } = await import('zod');
    const { readFileSync } = await import('fs');
    const { ToolRuntime } = await import('../src/core/tools/ToolRuntime');
    const { SessionLogService } = await import('../src/core/telemetry/SessionLogService');

    const dir = mkdtempSync(join(tmpdir(), 'thunder-tool-log-'));
    try {
      const runtime = new ToolRuntime();
      const log = new SessionLogService();
      log.configure(dir, 'tool-session', true, true);
      runtime.setSessionLog(log);
      runtime.register({
        name: 'run_command',
        description: 'Run command',
        risk: 'low',
        inputSchema: z.object({ command: z.string() }),
        execute: async (input: { command: string }) => ({ success: true, output: `ran ${input.command}` }),
      });

      const result = await runtime.execute('run_command', { command: 'npm test' });
      expect(result.success).toBe(true);

      const lines = readFileSync(log.getLogPath(), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
      const start = lines.find((event) => event.type === 'tool_start');
      const end = lines.find((event) => event.type === 'tool_end');
      expect(start.data.toolCallId).toEqual(expect.any(String));
      expect(end.data.toolCallId).toBe(start.data.toolCallId);
      expect(start.data.toolName).toBe('run_command');
      expect(start.data.command).toBe('npm test');
      expect(end.data.success).toBe(true);
      expect(end.data.durationMs).toEqual(expect.any(Number));
      expect(end.data.inputPreview).toContain('npm test');
      expect(end.data.outputPreview).toContain('ran npm test');
      expect(log.exportSummary()).toContain('## Tool calls');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe('UserExplicitContextBuilder', () => {
  it('injects full file content under token limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thunder-explicit-'));
    try {
      writeFileSync(join(dir, 'hello.ts'), 'export function hello() { return 1; }\n');
      const { UserExplicitContextBuilder } = await import('../src/core/context/UserExplicitContextBuilder');
      const builder = new UserExplicitContextBuilder(undefined, dir);
      const result = builder.build([{ path: 'hello.ts', kind: 'file' }]);
      expect(result.formatted).toContain('<user_explicit_context>');
      expect(result.formatted).toContain('<file path="hello.ts">');
      expect(result.formatted).toContain('export function hello');
      expect(result.items[0]?.source).toBe('user-explicit');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to scoped AST for large files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thunder-explicit-large-'));
    try {
      const body = Array.from({ length: 12000 }, (_, i) => `// line ${i}`).join('\n');
      writeFileSync(join(dir, 'big.ts'), `export class Big {}\n${body}`);
      const { UserExplicitContextBuilder } = await import('../src/core/context/UserExplicitContextBuilder');
      const builder = new UserExplicitContextBuilder(undefined, dir);
      const result = builder.build([{ path: 'big.ts', kind: 'file' }]);
      expect(result.formatted).toContain('representation="scoped-ast"');
      expect(result.formatted).toContain('class Big');
      expect(result.formatted).not.toContain('line 11000');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildPrompt explicit context', () => {
  it('places user_explicit_context before codebase context', async () => {
    const { buildPrompt } = await import('../src/core/planning/promptBuilder');
    const pack = {
      items: [],
      totalTokens: 0,
      formatted: 'auto context',
      retrievedCount: 0,
      budgetLimit: 1000,
      dropped: [],
      truncatedCount: 0,
    };
    const messages = buildPrompt(
      'plan',
      pack,
      'fix the bug',
      [],
      false,
      false,
      undefined,
      false,
      '<user_explicit_context><file path="a.ts">code</file></user_explicit_context>'
    );
    const user = messages.find((m) => m.role === 'user');
    expect(user?.content.startsWith('<user_explicit_context>')).toBe(true);
    expect(user?.content).toContain('## Codebase Context');
  });
});

describe('TaskAnalyzer direct error fix', () => {
  it('routes syntax/compiler errors to direct execution without replanning', async () => {
    const { analyzeTask } = await import('../src/core/agent/TaskAnalyzer');
    const message = `Syntax error: Missing semicolon. (2:28)
src/screens/kitchen-screen/components/DineInKanban.tsx

  1 | // BEFORE (crashed)
> 2 | '&::-webkit-scrollbar-thumb': (t) => ({`;

    const analysis = analyzeTask(message, 'act');
    expect(analysis.kind).toBe('simple_edit');
    expect(analysis.shouldPlan).toBe(false);
    expect(analysis.summary).toContain('DineInKanban.tsx');
  });
});

describe('SessionLogService timing', () => {
  it('records timing events and omits debug payloads when debugMetrics is off', async () => {
    const { SessionLogService } = await import('../src/core/telemetry/SessionLogService');
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-session-log-'));

    try {
      const service = new SessionLogService();
      service.configure(tempDir, 'test-session', true, false);
      service.appendTiming('context_retrieval', 120, { itemCount: 3 });
      service.appendDebug('tool_start', 'read_file', { input: { path: 'src/a.ts' } });
      service.append('tool_start', 'read_file', { tool: 'read_file' });

      const raw = service.exportForAnalysis();
      expect(raw).toContain('"type":"timing"');
      expect(raw).toContain('"durationMs":120');
      expect(raw).not.toContain('"input"');
      expect(raw).toContain('"tool":"read_file"');

      const summary = service.exportSummary();
      expect(summary).toContain('context_retrieval');
      expect(summary).toContain('120ms');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('captures debug payloads when debugMetrics is enabled', async () => {
    const { SessionLogService } = await import('../src/core/telemetry/SessionLogService');
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-session-log-debug-'));

    try {
      const service = new SessionLogService();
      service.configure(tempDir, 'debug-session', true, true);
      service.appendDebug('tool_start', 'read_file', { input: { path: 'src/a.ts' } });

      const raw = service.exportForAnalysis();
      expect(raw).toContain('"input"');
      expect(raw).toContain('src/a.ts');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
