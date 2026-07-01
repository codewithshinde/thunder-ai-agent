import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
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

  it('write_file creates parent directories for new nested files', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-write-nested-test-'));
    try {
      const { createWriteFileTool } = await import('../src/core/tools/builtinTools');
      const ig = new IgnoreService();
      ig.load(tempDir);
      const tool = createWriteFileTool(tempDir, ig);

      const result = await tool.execute({
        path: 'apps/docs/docs/ffb-mui/_category_.json',
        content: '{"label":"ffb-mui"}',
      });

      expect(result.success).toBe(true);
      expect(existsSync(join(tempDir, 'apps/docs/docs/ffb-mui/_category_.json'))).toBe(true);
      expect(readFileSync(join(tempDir, 'apps/docs/docs/ffb-mui/_category_.json'), 'utf8')).toContain('ffb-mui');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('read_file accepts absolute paths inside the workspace', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-read-absolute-test-'));
    try {
      const { createReadFileTool } = await import('../src/core/tools/builtinTools');
      const ig = new IgnoreService();
      ig.load(tempDir);
      const absPath = join(tempDir, 'apps/docs/docs/ffb-mui/api/formik-renderer.md');
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, '# FormikRenderer\n');

      const result = await createReadFileTool(tempDir, ig).execute({ path: absPath });

      expect(result.success).toBe(true);
      expect(result.output).toContain('FormikRenderer');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('serves repeat file reads from cache across read_file and read_files', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-read-cache-test-'));
    const targetRelPath = 'src/cache-target.ts';
    const targetPath = join(tempDir, targetRelPath);
    try {
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, 'export const cached = true;\n');

      vi.resetModules();
      const actualFsPromises = await vi.importActual<typeof import('fs/promises')>('fs/promises');
      const readFileSpy = vi.fn((...args: unknown[]) =>
        (actualFsPromises.readFile as (...innerArgs: unknown[]) => Promise<unknown>)(...args)
      );
      vi.doMock('fs/promises', async () => ({
        ...(await vi.importActual<typeof import('fs/promises')>('fs/promises')),
        readFile: readFileSpy,
      }));

      const { clearReadFileCache, createReadFileTool, createReadFilesTool } = await import('../src/core/tools/builtinTools');
      clearReadFileCache(tempDir);
      const ig = new IgnoreService();
      ig.load(tempDir);

      const first = await createReadFileTool(tempDir, ig).execute({ path: targetRelPath });
      const second = await createReadFilesTool(tempDir, ig).execute({ paths: [targetRelPath] });

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      expect(second.output).toContain('export const cached = true;');
      expect(readFileSpy.mock.calls.filter(([path]) => String(path) === targetPath)).toHaveLength(1);
    } finally {
      vi.doUnmock('fs/promises');
      vi.resetModules();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('list_files accepts absolute directories inside the workspace', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-list-absolute-test-'));
    try {
      const { createListFilesTool } = await import('../src/core/tools/builtinTools');
      const ig = new IgnoreService();
      ig.load(tempDir);
      const absDir = join(tempDir, 'apps/docs/docs/ffb-mui/api');
      mkdirSync(absDir, { recursive: true });
      writeFileSync(join(absDir, 'formik-renderer.md'), '# FormikRenderer\n');

      const result = await createListFilesTool(tempDir, ig).execute({ path: absDir, recursive: false });

      expect(result.success).toBe(true);
      expect(result.output).toContain('formik-renderer.md');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects absolute paths outside the workspace', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-outside-workspace-test-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'thunder-outside-file-test-'));
    try {
      const { createReadFileTool } = await import('../src/core/tools/builtinTools');
      const ig = new IgnoreService();
      ig.load(tempDir);
      const outsideFile = join(outsideDir, 'secret.ts');
      writeFileSync(outsideFile, 'export const secret = true;');

      const result = await createReadFileTool(tempDir, ig).execute({ path: outsideFile });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid (or ignored )?path/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('read_files recovers gracefully from batches over 12 paths', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-read-files-limit-test-'));
    try {
      const { createReadFilesTool } = await import('../src/core/tools/builtinTools');
      const ig = new IgnoreService();
      ig.load(tempDir);
      for (let i = 1; i <= 13; i++) {
        writeFileSync(join(tempDir, `file-${i}.ts`), `export const n = ${i};`);
      }
      const tool = createReadFilesTool(tempDir, ig);

      const result = await tool.execute({
        paths: Array.from({ length: 13 }, (_, i) => `file-${i + 1}.ts`),
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('at most 12 paths');
      expect(result.output).toContain('file-13.ts');
      expect(result.output).toContain('### file-12.ts');
      expect(result.output).not.toContain('### file-13.ts');
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

  it('refuses raw TypeScript generics in MDX table cells', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-mdx-generic-guard-test-'));
    try {
      const ig = new IgnoreService();
      ig.load(tempDir);
      const { createWriteFileTool } = await import('../src/core/tools/builtinTools');
      const result = await createWriteFileTool(tempDir, ig).execute({
        path: 'docs/ffb-mui/api/formik-renderer.md',
        content: [
          '### Props',
          '',
          '| Name | Type | Required | Description |',
          '|------|------|----------|-------------|',
          '| initialValues | Record<string, any> | Yes | Initial form values |',
          '| onSubmit | (values: Record<string, any>) => void | Yes | Form submission handler |',
        ].join('\n'),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('raw TypeScript generic');
      expect(result.error).toContain('Unexpected character');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('allows code-spanned TypeScript generics in MDX table cells', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-mdx-generic-ok-test-'));
    try {
      const ig = new IgnoreService();
      ig.load(tempDir);
      const { createWriteFileTool } = await import('../src/core/tools/builtinTools');
      const result = await createWriteFileTool(tempDir, ig).execute({
        path: 'docs/ffb-mui/api/formik-renderer.md',
        content: [
          '### Props',
          '',
          '| Name | Type | Required | Description |',
          '|------|------|----------|-------------|',
          '| initialValues | `Record<string, any>` | Yes | Initial form values |',
          '| onSubmit | `(values: Record<string, any>) => void` | Yes | Form submission handler |',
        ].join('\n'),
      });

      expect(result.success).toBe(true);
      expect(readFileSync(join(tempDir, 'docs/ffb-mui/api/formik-renderer.md'), 'utf8')).toContain('`Record<string, any>`');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses broken LiveCodeBlock JSX attribute expressions in MDX files', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-mdx-livecodeblock-test-'));
    try {
      const ig = new IgnoreService();
      ig.load(tempDir);
      const { createWriteFileTool } = await import('../src/core/tools/builtinTools');
      const result = await createWriteFileTool(tempDir, ig).execute({
        path: 'docs/ffb-mui/api/formik-renderer.md',
        content: [
          '<LiveCodeBlock',
          '  code={',
          '`import React from "react";',
          'export default function SimpleForm() { return null; }',
          'render(<SimpleForm />);`',
          '  componentName="SimpleForm"',
          '/>',
        ].join('\n'),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Could not parse expression with acorn');
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
            url: '',
            headers: {},
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

  it('disables built-ins when session toggles are off', async () => {
    const { resolveMcpServers } = await import('../src/core/mcp/McpManager');
    const config = defaultThunderConfig();
    const servers = resolveMcpServers(config.mcp, '/tmp/project', {
      filesystem: true,
      memory: false,
      sequentialThinking: true,
    });
    expect(servers.memory.disabled).toBe(true);
    expect(servers.filesystem.disabled).toBe(false);
  });

  it('defaults built-in MCP toggles on', () => {
    expect(defaultThunderConfig().mcp.builtinServers).toEqual({
      filesystem: true,
      memory: true,
      sequentialThinking: true,
    });
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

  it('plans and verifies actionable requests in agent mode', async () => {
    const { analyzeTask } = await import('../src/core/agent/TaskAnalyzer');
    const analysis = analyzeTask('Implement a solid planning mode and separate act mode', 'agent');

    expect(analysis.kind).toBe('implementation');
    expect(analysis.shouldPlan).toBe(true);
    expect(analysis.shouldVerify).toBe(true);
  });

  it('treats ask mode as read-only question answering', async () => {
    const { analyzeTask } = await import('../src/core/agent/TaskAnalyzer');
    const analysis = analyzeTask('implement auth and add tests for all routes', 'ask');

    expect(analysis.kind).toBe('question');
    expect(analysis.complexity).toBe('high');
    expect(analysis.shouldPlan).toBe(false);
    expect(analysis.shouldVerify).toBe(false);
    expect(analysis.shouldUseSubagents).toBe(true);
    expect(analysis.askIntent).toBe('implement_here');
    expect(analysis.summary).toContain('Ask mode');
  });
});

describe('Ask mode helpers', () => {
  it('filters tools to the Ask allowlist', async () => {
    const { filterAskModeTools, ASK_ALLOWED_TOOLS } = await import('../src/core/agent/askMode');
    const tools = [
      { type: 'function' as const, function: { name: 'read_file', description: '', parameters: {} } },
      { type: 'function' as const, function: { name: 'write_file', description: '', parameters: {} } },
      { type: 'function' as const, function: { name: 'analyze_change_impact', description: '', parameters: {} } },
      { type: 'function' as const, function: { name: 'mcp__fs__read', description: '', parameters: {} } },
    ];
    const filtered = filterAskModeTools(tools);
    expect(filtered.map((t) => t.function.name)).toEqual(['read_file', 'analyze_change_impact', 'mcp__fs__read']);
    expect(ASK_ALLOWED_TOOLS.has('spawn_research_agent')).toBe(true);
    expect(ASK_ALLOWED_TOOLS.has('project_catalog')).toBe(true);
    expect(ASK_ALLOWED_TOOLS.has('write_file')).toBe(false);
  });

  it('detects when Ask answers need grounding', async () => {
    const { needsAskGrounding, isGeneralKnowledgeQuestion, shouldEnableAskSubagents } =
      await import('../src/core/agent/askMode');

    expect(needsAskGrounding('Where is ChatOrchestrator.send defined?')).toBe(true);
    expect(needsAskGrounding('hi')).toBe(false);
    expect(isGeneralKnowledgeQuestion('What is a binary search tree?')).toBe(true);
    expect(needsAskGrounding('What is a binary search tree?')).toBe(false);
    expect(shouldEnableAskSubagents('How does authentication flow across the entire codebase?')).toBe(true);
    expect(shouldEnableAskSubagents('How do I implement OAuth in this project?')).toBe(true);
    expect(shouldEnableAskSubagents('What is OAuth?')).toBe(false);
  });

  it('blocks disallowed tools in ask mode via ToolExecutor', async () => {
    const { ToolExecutor } = await import('../src/core/safety/ToolExecutor');
    const { ToolRuntime } = await import('../src/core/tools/ToolRuntime');
    const { ToolPolicyEngine } = await import('../src/core/safety/ToolPolicyEngine');
    const { ApprovalQueue } = await import('../src/core/safety/ApprovalQueue');

    const runtime = new ToolRuntime();
    const executor = new ToolExecutor(
      runtime,
      new ToolPolicyEngine({
        requireApprovalForWrites: true,
        requireApprovalForShell: true,
        allowNetwork: false,
        blockDangerousCommands: true,
      }, () => false),
      new ApprovalQueue(),
      () => 'session-1',
      () => 'ask'
    );

    const result = await executor.execute('mark_step_complete', { stepId: 'step-1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not available in Ask mode');
  });
});

describe('ThunderMode normalization', () => {
  it('maps legacy act to agent', async () => {
    const { normalizeThunderMode } = await import('../src/core/ThunderSession');
    expect(normalizeThunderMode('act')).toBe('agent');
    expect(normalizeThunderMode('ask')).toBe('ask');
    expect(normalizeThunderMode('unknown')).toBe('plan');
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
    const actMode = await executor.generatePlan(provider, 'agent', pack, 'fix bug');

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
      { id: 's1', mode: 'agent' } as never,
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
      { id: 's1', mode: 'agent' } as never,
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

  it('resolveEffectiveSafety keeps auto approval when preset is guided', async () => {
    const { resolveEffectiveSafety } = await import('../src/core/safety/autonomyPresets');
    const resolved = resolveEffectiveSafety({
      ...defaultThunderConfig().safety,
      approvalMode: 'auto',
      autonomyPreset: 'guided',
    });
    expect(resolved.approvalMode).toBe('auto');
    expect(resolved.requireApprovalForWrites).toBe(false);
    expect(resolved.requireApprovalForShell).toBe(false);
    expect(resolved.allowNetwork).toBe(true);
  });

  it('resolveEffectiveSafety honors ask_edits over pilot preset defaults', async () => {
    const { resolveEffectiveSafety } = await import('../src/core/safety/autonomyPresets');
    const resolved = resolveEffectiveSafety({
      ...defaultThunderConfig().safety,
      approvalMode: 'ask_edits',
      autonomyPreset: 'pilot',
    });
    expect(resolved.approvalMode).toBe('ask_edits');
    expect(resolved.requireApprovalForWrites).toBe(true);
    expect(resolved.requireApprovalForShell).toBe(false);
  });

  it('differentiates safe, guided, and builder', async () => {
    const { applyAutonomyPreset } = await import('../src/core/safety/autonomyPresets');
    const base = defaultThunderConfig().safety;
    const safe = applyAutonomyPreset(base, 'safe');
    const guided = applyAutonomyPreset(base, 'guided');
    const builder = applyAutonomyPreset(base, 'builder');
    expect(safe.allowNetwork).toBe(false);
    expect(guided.allowNetwork).toBe(true);
    expect(builder.requireApprovalForWrites).toBe(false);
    expect(guided.approvalMode).toBe('ask_edits');
    expect(builder.approvalMode).toBe('ask_commands');
  });
});

describe('shouldDecomposeTask', () => {
  it('decomposes implementation tasks and explicit plan requests in act mode', async () => {
    const { shouldDecomposeTask } = await import('../src/core/agent/TaskAnalyzer');
    expect(
      shouldDecomposeTask('implement auth and then add tests step by step for all routes', 'agent')
    ).toBe(true);
    expect(shouldDecomposeTask('implement auth and then add tests for all routes', 'agent')).toBe(true);
    expect(
      shouldDecomposeTask('identify and remove unused files and dependencies in the whole project', 'agent')
    ).toBe(true);
    expect(shouldDecomposeTask('implement auth and then add tests', 'plan')).toBe(true);
    expect(shouldDecomposeTask('hi', 'agent')).toBe(false);
    expect(shouldDecomposeTask('what does this project do?', 'agent')).toBe(false);
  });
});

describe('TaskAnalyzer', () => {
  it('classifies task kinds', async () => {
    const { analyzeTask } = await import('../src/core/agent/TaskAnalyzer');
    const audit = analyzeTask('find unused dependencies and clean up dead code', 'agent');
    expect(audit.kind).toBe('audit');
    expect(audit.shouldPlan).toBe(true);

    const question = analyzeTask('how does authentication work?', 'agent');
    expect(question.kind).toBe('question');
    expect(question.shouldPlan).toBe(false);

    const impl = analyzeTask('implement login and then add tests for the auth module', 'agent');
    expect(impl.kind).toBe('implementation');
    expect(impl.shouldPlan).toBe(true);
    expect(impl.shouldVerify).toBe(true);
  });

  it('classifies UI polish requests with typos as implementation work', async () => {
    const { analyzeTask } = await import('../src/core/agent/TaskAnalyzer');
    const result = analyzeTask(
      '@src/utils/kitchen-status.ts Can you imporve the Ui and UX of this file and also its child compoenents, cards and all',
      'agent'
    );

    expect(result.kind).toBe('implementation');
    expect(result.shouldPlan).toBe(true);
    expect(result.shouldVerify).toBe(true);
  });

  it('treats short product/action trigger words as implementation work', async () => {
    const { analyzeTask } = await import('../src/core/agent/TaskAnalyzer');
    const result = analyzeTask('need animated enterprise landing page UI', 'agent');

    expect(result.kind).toBe('implementation');
    expect(result.shouldPlan).toBe(true);
    expect(result.shouldVerify).toBe(true);
  });

  it('plans broad documentation feature work', async () => {
    const { analyzeTask } = await import('../src/core/agent/TaskAnalyzer');
    const result = analyzeTask('add docs for all ffb-mui features', 'agent');

    expect(result.kind).toBe('implementation');
    expect(result.complexity).toBe('medium');
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

  it('excludes internal agent log files from passive editor context', async () => {
    const { isFileContextRelevant, isInternalAgentPath } = await import('../src/core/context/contextRelevance');
    expect(isInternalAgentPath('.thunder/logs/session.jsonl')).toBe(true);
    expect(isFileContextRelevant('add docs for all ffb-mui features', '.thunder/logs/session.jsonl')).toBe(false);
  });
});

describe('context query expansion', () => {
  it('adds docs routing and package export hints for broad docs tasks', async () => {
    const { expandContextQuery } = await import('../src/core/context/contextQueryExpansion');
    const expanded = expandContextQuery('add docs for all ffb-mui features');

    expect(expanded).toContain('apps/docs/docusaurus.config.ts');
    expect(expanded).toContain('sidebars.ts');
    expect(expanded).toContain('packages/ffb-mui/src/index.ts');
    expect(expanded).toContain('packages/ffb-mui/src/fields/index.ts');
  });

  it('uses package-like names as indexed path search terms', async () => {
    const { extractIndexedSearchTerms } = await import('../src/core/context/fuzzyFileMatch');
    expect(extractIndexedSearchTerms('add docs for all ffb-mui features')).toContain('ffb-mui');
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
    const result = analyzeTask('Continue the current approved task from where it paused.\nOriginal user request: refactor app', 'agent');
    expect(result.shouldPlan).toBe(false);
    expect(result.summary).toContain('resume');
  });

  it('classifies cleanup tasks with common typos as audit', async () => {
    const { analyzeTask } = await import('../src/core/agent/TaskAnalyzer');
    const result = analyzeTask(
      'Can you remove all the unsed imports and files and dependencies from the entire porject',
      'agent'
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
    const analysis = analyzeTask('remove unused imports and dependencies', 'agent');
    expect(analysis.kind).toBe('audit');
    expect(shouldUsePlanner('agent', analysis, true, true)).toBe(false);
    expect(shouldUsePlanner('agent', analysis, true, false)).toBe(true);
    expect(shouldUsePlanner('plan', analysis, true, true)).toBe(true);
  });

  it('removes plan-only tools from direct agent runs', async () => {
    const { filterDirectAgentTools, shouldRunDirectFinalValidation } = await import('../src/core/ChatOrchestrator');
    const tools = [
      { type: 'function', function: { name: 'read_file', description: '', parameters: {} } },
      { type: 'function', function: { name: 'mark_step_complete', description: '', parameters: {} } },
      { type: 'function', function: { name: 'propose_plan_mutation', description: '', parameters: {} } },
      { type: 'function', function: { name: 'apply_patch', description: '', parameters: {} } },
    ] as const;

    expect(filterDirectAgentTools([...tools]).map((tool) => tool.function.name)).toEqual([
      'read_file',
      'apply_patch',
    ]);
    expect(shouldRunDirectFinalValidation('simple_edit')).toBe(false);
    expect(shouldRunDirectFinalValidation('simple_edit', ['apps/docs/docs/ffb-mui/example.mdx'])).toBe(true);
    expect(shouldRunDirectFinalValidation('implementation')).toBe(true);
  });
});

describe('AgentTaskState', () => {
  it('blocks repeated depcheck after analyze completes', async () => {
    const { AgentTaskState } = await import('../src/core/agent/AgentTaskState');
    const state = new AgentTaskState();
    state.setTaskContext('audit', 'Audit/cleanup task', 'remove unused dependencies');
    state.recordToolSuccess('run_command', { command: 'npx depcheck' }, 'Unused: foo');
    expect(state.getPhase()).toBe('execute');
    const blocked = state.checkBlocked('run_command', { command: 'npx depcheck --ignores=x' });
    expect(blocked).toContain('depcheck');
    const soft = state.buildSoftBlockResponse('run_command', { command: 'npx depcheck --ignores=x' });
    expect(soft).toContain('confirmed cleanup changes');
    expect(soft).toContain('package.json');
  });

  it('allows depcheck again after write_file', async () => {
    const { AgentTaskState } = await import('../src/core/agent/AgentTaskState');
    const state = new AgentTaskState();
    state.setTaskContext('audit', 'Audit/cleanup task', 'remove unused dependencies');
    state.recordToolSuccess('run_command', { command: 'npx depcheck' }, 'Unused: foo');
    state.recordToolSuccess('write_file', { path: 'package.json' }, 'Wrote file');
    const blocked = state.checkBlocked('run_command', { command: 'npx depcheck' });
    expect(blocked).toBeNull();
  });

  it('blocks repeated verification after edits already verified', async () => {
    const { AgentTaskState, normalizeDiagnosticKey } = await import('../src/core/agent/AgentTaskState');
    const state = new AgentTaskState();
    state.setTaskContext(
      'simple_edit',
      'Compiler/runtime error in apps/docs/src/components/live-demo-mui.tsx',
      "Module not found: Error: Can't resolve 'ffb-mui'"
    );
    state.recordToolSuccess('apply_patch', { path: 'apps/docs/src/components/live-demo-mui.tsx' }, 'Patch applied');
    state.recordToolSuccess(
      'run_command',
      { command: 'cd apps/docs && npm run build 2>&1 | grep -i "cannot find module" || echo "No errors"' },
      'No errors'
    );

    const soft = state.buildSoftBlockResponse('run_command', {
      command: 'cd apps/docs && npm run build 2>&1 | grep -i "cannot find module" || echo "No errors"',
    });

    expect(soft).toContain('already succeeded after edits');
    expect(soft).toContain('Stop using tools now');
    expect(soft).toContain('No errors');
    expect(normalizeDiagnosticKey('cd packages/ffb-mui && npm run build:types')).toBeNull();
    expect(normalizeDiagnosticKey('cd apps/docs && npm run build')).toBe('docs-build');
  });

  it('builds pause summary with next step hint', async () => {
    const { AgentTaskState } = await import('../src/core/agent/AgentTaskState');
    const state = new AgentTaskState();
    state.setTaskContext('audit', 'Audit/cleanup task', 'remove unused dependencies');
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
    expect(soft).toContain('smallest exact next action');
    expect(soft).not.toContain('package.json');
  });

  it('uses MDX repair guidance instead of audit cleanup guidance', async () => {
    const { AgentTaskState } = await import('../src/core/agent/AgentTaskState');
    const state = new AgentTaskState();
    state.setTaskContext(
      'simple_edit',
      'MDX/Docusaurus compilation error in apps/docs/docs/ffb-mui/api/formik-renderer.md',
      'Error: MDX compilation failed for file "apps/docs/docs/ffb-mui/api/formik-renderer.md"'
    );
    state.recordToolSuccess('run_command', { command: 'rg -n "Record<string, any>" apps/docs/docs/ffb-mui' }, 'formik-renderer.md:17');
    const soft = state.buildSoftBlockResponse('run_command', { command: 'rg -n "Record<string, any>" apps/docs/docs/ffb-mui' });
    expect(soft).toContain('MDX repair loop');
    expect(soft).toContain('Read the exact MDX file');
    expect(soft).toContain('Unexpected character `,` in name');
    expect(soft).toContain('Could not parse expression with acorn');
    expect(soft).toContain('form-builder.md');
    expect(soft).toContain('Run the docs build');
    expect(soft).not.toContain('Remove unused dependencies');
    expect(state.buildApprovalResumeInstruction()).toContain('fix only the next exact MDX/Docusaurus failure');
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
    expect(isReadOnlyCommand('npx docusaurus build')).toBe(true);
    expect(isReadOnlyCommand('cd apps/docs && npm run build 2>&1 | head -50')).toBe(true);
    expect(isReadOnlyCommand('npx vitest run')).toBe(true);
    expect(isReadOnlyCommand('npx vitest')).toBe(false);
    expect(stripLeadingCd('cd /home/user && npm ls')).toBe('npm ls');
    expect(isShellAllowed('plan', 'npx depcheck')).toBe(true);
    expect(isShellAllowed('ask', 'npx depcheck')).toBe(true);
    expect(isShellAllowed('plan', 'npm install lodash')).toBe(false);
    expect(isShellAllowed('ask', 'npm install lodash')).toBe(false);
    expect(isToolAllowedInPlanPhase('execute', 'run_command', { command: 'npm run build' }).allowed).toBe(true);
    expect(isToolAllowedInPlanPhase('verify', 'run_command', { command: 'npm run build' }).allowed).toBe(true);
    expect(isToolAllowedInPlanPhase('verify', 'run_command', { command: 'node scripts/custom-mutator.js' }).allowed).toBe(false);
  });

  it('upgrades write-intent steps from diagnostics to execute in agent mode', async () => {
    const { resolveStepPhaseLock, stepImpliesWrite } = await import('../src/core/planning/PlanActEngine');
    expect(stepImpliesWrite({ title: 'Audit Current Implementation & Identify Bugs' })).toBe(false);
    expect(stepImpliesWrite({ title: 'Fix ReferenceError & Prepare Theme Utilities' })).toBe(true);
    expect(
      resolveStepPhaseLock(
        { title: 'Fix ReferenceError & Prepare Theme Utilities', phase: 'diagnostics' },
        'agent'
      )
    ).toBe('execute');
    expect(
      resolveStepPhaseLock(
        { title: 'Audit Current Implementation & Identify Bugs', phase: 'diagnostics' },
        'agent'
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

describe('verifyCommandDiscovery', () => {
  it('skips missing npm scripts and placeholder npm tests', async () => {
    const { resolveProjectVerifyCommands } = await import('../src/core/agent/verifyCommandDiscovery');
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-verify-npm-test-'));
    try {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        scripts: {
          test: 'echo "Error: no test specified" && exit 1',
          typecheck: 'tsc --noEmit',
        },
      }));

      const plan = resolveProjectVerifyCommands(tempDir, ['npm run lint', 'npm test']);

      expect(plan.commands).toEqual(['npm run typecheck']);
      expect(plan.skipped.join('\n')).toContain('script "lint" not found');
      expect(plan.skipped.join('\n')).toContain('test script is a placeholder');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('uses the first matching docs build command from workspace suggestions', async () => {
    const { resolveProjectVerifyCommands } = await import('../src/core/agent/verifyCommandDiscovery');
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-verify-docs-test-'));
    try {
      const docsDir = join(tempDir, 'apps/docs');
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        scripts: { build: 'echo root build' },
      }));
      writeFileSync(join(docsDir, 'package.json'), JSON.stringify({
        name: 'docs',
        scripts: { build: 'docusaurus build' },
      }));

      const plan = resolveProjectVerifyCommands(tempDir, [
        'cd apps/docs && npm run build',
        'npm run build --workspace docs',
        'pnpm --filter docs build',
        'npm run build',
      ]);

      expect(plan.commands).toEqual(['cd apps/docs && npm run build']);
      expect(plan.skipped.join('\n')).not.toContain('npm run build:');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('adds docs build verification when docs files changed and default verify scripts are missing', async () => {
    const { resolveProjectVerifyCommands } = await import('../src/core/agent/verifyCommandDiscovery');
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-verify-docs-touched-test-'));
    try {
      const docsDir = join(tempDir, 'apps/docs');
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        scripts: {
          test: 'echo "Error: no test specified" && exit 1',
        },
      }));
      writeFileSync(join(docsDir, 'package.json'), JSON.stringify({
        name: 'docs',
        scripts: { build: 'docusaurus build' },
      }));

      const plan = resolveProjectVerifyCommands(tempDir, ['npm run lint', 'npm test'], {
        touchedFiles: ['apps/docs/docs/ffb-mui/components/multi-text/basic-multi-text-example.mdx'],
      });

      expect(plan.commands).toEqual(['cd apps/docs && npm run build']);
      expect(plan.skipped.join('\n')).toContain('script "lint" not found');
      expect(plan.skipped.join('\n')).toContain('test script is a placeholder');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('discovers non-JS test commands from manifests only when appropriate', async () => {
    const { resolveProjectVerifyCommands } = await import('../src/core/agent/verifyCommandDiscovery');
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-verify-polyglot-test-'));
    try {
      writeFileSync(join(tempDir, 'pom.xml'), '<project />');
      expect(resolveProjectVerifyCommands(tempDir, ['npm run lint', 'npm test']).commands).toEqual(['mvn test']);

      rmSync(join(tempDir, 'pom.xml'));
      writeFileSync(join(tempDir, 'go.mod'), 'module example.com/app\n');
      expect(resolveProjectVerifyCommands(tempDir, ['npm run lint', 'npm test']).commands).toEqual([]);
      writeFileSync(join(tempDir, 'main_test.go'), 'package main\n');
      expect(resolveProjectVerifyCommands(tempDir, ['npm run lint', 'npm test']).commands).toEqual(['go test ./...']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
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

  it('strips embedded workspace root from pseudo-absolute paths', async () => {
    const { resolveWorkspaceRelPath } = await import('../src/core/vscode/pathUtils');
    const ws = '/Users/me/proj';
    expect(resolveWorkspaceRelPath(ws, 'Users/me/proj/apps/docs/config.ts')).toBe('apps/docs/config.ts');
    expect(resolveWorkspaceRelPath(ws, '/Users/me/proj/apps/docs/config.ts')).toBe('apps/docs/config.ts');
    expect(resolveWorkspaceRelPath(ws, 'apps/docs/config.ts')).toBe('apps/docs/config.ts');
  });

  it('suggests extension variants for missing paths', async () => {
    const { pathExistenceVariants } = await import('../src/core/vscode/pathUtils');
    const variants = pathExistenceVariants('apps/docs/docusaurus.config.js');
    expect(variants).toContain('apps/docs/docusaurus.config.ts');
  });
});

describe('modelNormalize', () => {
  it('maps deepseek-v4-flash to deepseek-chat', async () => {
    const { normalizeProviderModel } = await import('../src/core/llm/modelNormalize');
    expect(normalizeProviderModel('deepseek', 'deepseek-v4-flash').model).toBe('deepseek-chat');
  });

  it('rejects local Ollama model ids on DeepSeek provider', async () => {
    const { normalizeProviderModel } = await import('../src/core/llm/modelNormalize');
    const result = normalizeProviderModel('deepseek', 'qwen3-coder:30b');
    expect(result.model).toBe('deepseek-chat');
    expect(result.warning).toMatch(/local/i);
  });
});

describe('toolAliases', () => {
  it('maps search_files to search', async () => {
    const { resolveToolName } = await import('../src/core/tools/toolAliases');
    expect(resolveToolName('search_files')).toBe('search');
  });
});

describe('promptBuilder', () => {
  it('includes cause-specific MDX generic repair guidance', async () => {
    const { buildSystemPrompt } = await import('../src/core/planning/promptBuilder');
    const prompt = buildSystemPrompt('agent', true);

    expect(prompt).toContain('Unexpected character `,` in name');
    expect(prompt).toContain('Record<string, any>');
    expect(prompt).toContain('Could not parse expression with acorn');
    expect(prompt).toContain("Can't resolve");
    expect(prompt).toContain('form-builder.md');
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

  it('rejects MDX patches that leave raw TypeScript generics in table cells', async () => {
    const { PatchApplyService } = await import('../src/core/apply/PatchApplyService');
    const svc = new PatchApplyService('/tmp');
    const result = svc.validateSyntax(
      'docs/ffb-mui/api/formik-renderer.md',
      [
        '| Name | Type | Required | Description |',
        '|------|------|----------|-------------|',
        '| initialValues | Record<string, any> | Yes | Initial form values |',
      ].join('\n')
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('raw TypeScript generic');
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
    log.writeSessionHeader({ mode: 'agent' });
    log.append('user_message', 'hello', { mode: 'agent' });
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
      false,
      undefined,
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

    const analysis = analyzeTask(message, 'agent');
    expect(analysis.kind).toBe('simple_edit');
    expect(analysis.shouldPlan).toBe(false);
    expect(analysis.summary).toContain('DineInKanban.tsx');
  });

  it('routes MDX compilation failures to direct exact-file repair', async () => {
    const { analyzeTask } = await import('../src/core/agent/TaskAnalyzer');
    const analysis = analyzeTask(
      'Error: MDX compilation failed for file "/repo/apps/docs/docs/ffb-mui/api/formik-renderer.md" Cause: Unexpected character `,`',
      'agent'
    );

    expect(analysis.kind).toBe('simple_edit');
    expect(analysis.shouldPlan).toBe(false);
    expect(analysis.shouldVerify).toBe(true);
    expect(analysis.summary).toContain('MDX/Docusaurus compilation error');
    expect(analysis.summary).toContain('formik-renderer.md');
  });

  it('routes module resolution failures in docs builds to direct repair', async () => {
    const { analyzeTask } = await import('../src/core/agent/TaskAnalyzer');
    const analysis = analyzeTask(
      "Module not found: Error: Can't resolve 'ffb-mui' in '/repo/apps/docs/src/components'",
      'agent'
    );

    expect(analysis.kind).toBe('simple_edit');
    expect(analysis.shouldPlan).toBe(false);
    expect(analysis.shouldVerify).toBe(true);
  });
});

describe('mdxRepairRouting', () => {
  it('detects pasted Docusaurus build failures', async () => {
    const { isMdxRepairTask, extractMdxErrorFile, buildMdxRepairBootstrapBlock } = await import(
      '../src/core/agent/mdxRepairRouting'
    );
    const text = `Compiled with problems:
ERROR in ./docs/ffb-mui/api/formik-renderer.md
MDX compilation failed for file "/repo/apps/docs/docs/ffb-mui/api/formik-renderer.md"
Cause: Could not parse expression with acorn`;

    expect(isMdxRepairTask(text)).toBe(true);
    expect(extractMdxErrorFile(text)).toContain('formik-renderer.md');
    expect(buildMdxRepairBootstrapBlock(extractMdxErrorFile(text))).toContain('form-builder.md');
    expect(buildMdxRepairBootstrapBlock(extractMdxErrorFile(text))).toContain("Can't resolve");
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

describe('workspace scaffolding', () => {
  it('creates default .mitii/mcp.json and README on first init', async () => {
    const { mkdtempSync, existsSync, readFileSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const { scaffoldMitiiWorkspace } = await import('../src/core/mcp/scaffoldMitiiWorkspace');

    const dir = mkdtempSync(join(tmpdir(), 'thunder-scaffold-'));
    try {
      scaffoldMitiiWorkspace(dir);
      const mcpPath = join(dir, '.mitii', 'mcp.json');
      const readmePath = join(dir, '.mitii', 'README.md');
      expect(existsSync(mcpPath)).toBe(true);
      expect(existsSync(readmePath)).toBe(true);
      const mcp = JSON.parse(readFileSync(mcpPath, 'utf-8')) as { mcpServers: Record<string, unknown> };
      expect(mcp.mcpServers).toEqual({});
      expect(readFileSync(readmePath, 'utf-8')).toContain('filesystem');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not overwrite existing mcp.json', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const { scaffoldMitiiWorkspace } = await import('../src/core/mcp/scaffoldMitiiWorkspace');

    const dir = mkdtempSync(join(tmpdir(), 'thunder-scaffold-'));
    try {
      mkdirSync(join(dir, '.mitii'), { recursive: true });
      writeFileSync(join(dir, '.mitii', 'mcp.json'), '{"mcpServers":{"custom":{}}}\n');
      scaffoldMitiiWorkspace(dir);
      expect(readFileSync(join(dir, '.mitii', 'mcp.json'), 'utf-8')).toContain('custom');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('run_command exit codes', () => {
  it('treats rg exit 1 as success but not npm test failures', async () => {
    const { mkdtempSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const { createRunCommandTool } = await import('../src/core/tools/builtinTools');

    const dir = mkdtempSync(join(tmpdir(), 'thunder-cmd-'));
    try {
      const tool = createRunCommandTool(dir, () => 'agent');
      const grep = await tool.execute({ command: 'grep -r "__definitely_missing_pattern_xyz__" .' });
      expect(grep.success).toBe(true);

      const npm = await tool.execute({ command: 'npm test' });
      expect(npm.success).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Ask v2 routing, scope, and impact', () => {
  it('routes canonical Ask intents and profiles', async () => {
    const { routeAskIntent } = await import('../src/core/ask');

    expect(routeAskIntent('Where is Ask mode defined?')).toMatchObject({
      intent: 'locate',
      profile: 'concise',
      includeImpact: false,
    });
    expect(routeAskIntent('Explain ChatOrchestrator flow across the repo')).toMatchObject({
      intent: 'architecture',
      profile: 'deep',
      shouldUseSubagents: true,
    });
    expect(routeAskIntent('How do I implement OAuth in this project?')).toMatchObject({
      intent: 'implement_here',
      profile: 'deep',
      includeImpact: true,
      allowWeb: true,
    });
    expect(routeAskIntent('What is recursion?')).toMatchObject({
      intent: 'general_knowledge',
      groundingRequired: false,
    });
  });

  it('discovers monorepo projects and persists a catalog file', async () => {
    const { discoverProjectCatalog, saveProjectCatalog, loadProjectCatalog, formatProjectCatalog } =
      await import('../src/core/ask');
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-project-catalog-test-'));
    try {
      writeFileSync(join(tempDir, 'pnpm-workspace.yaml'), ['packages:', "  - 'apps/*'", "  - 'packages/*'"].join('\n'));
      mkdirSync(join(tempDir, 'apps/docs'), { recursive: true });
      writeFileSync(join(tempDir, 'apps/docs/package.json'), JSON.stringify({
        name: 'mitii-docs',
        dependencies: { '@docusaurus/core': '^3.0.0' },
        scripts: { build: 'docusaurus build' },
      }));
      writeFileSync(join(tempDir, 'apps/docs/docusaurus.config.ts'), 'export default {};');
      mkdirSync(join(tempDir, 'packages/sdk/src'), { recursive: true });
      writeFileSync(join(tempDir, 'packages/sdk/package.json'), JSON.stringify({
        name: '@mitii/sdk',
        scripts: { test: 'vitest' },
      }));
      writeFileSync(join(tempDir, 'packages/sdk/src/index.ts'), 'export const sdk = true;');

      const catalog = discoverProjectCatalog(tempDir);
      expect(catalog.projects.map((project) => project.id)).toEqual(['docs', 'sdk']);
      expect(catalog.projects.find((project) => project.id === 'docs')?.type).toBe('docs');
      expect(catalog.projects.find((project) => project.id === 'sdk')?.type).toBe('lib');

      saveProjectCatalog(catalog);
      expect(existsSync(join(tempDir, '.mitii/projects.json'))).toBe(true);
      expect(loadProjectCatalog(tempDir).projects).toHaveLength(2);
      expect(formatProjectCatalog(catalog)).toContain('## Workspace projects');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('resolves explicit, type-based, and cross-project scopes', async () => {
    const { resolveAskScope } = await import('../src/core/ask');
    const catalog = {
      workspaceRoot: '/tmp/repo',
      generatedAt: 'now',
      projects: [
        { id: 'agent', name: 'mitii-agent', root: 'apps/agent', type: 'extension' as const, entryFiles: [], scripts: {} },
        { id: 'docs', name: 'mitii-docs', root: 'apps/docs', type: 'docs' as const, entryFiles: [], scripts: {} },
      ],
    };

    expect(resolveAskScope('How do I implement OAuth in mitii-docs?', catalog)).toMatchObject({
      status: 'matched',
      scopeRoot: 'apps/docs',
    });
    expect(resolveAskScope('Where is the extension entry point?', catalog)).toMatchObject({
      status: 'matched',
      scopeRoot: 'apps/agent',
    });
    expect(resolveAskScope('How do docs relate to the agent across projects?', catalog).status).toBe('all');
  });

  it('analyzes likely affected files without mutating source files', async () => {
    const { analyzeChangeImpact } = await import('../src/core/ask');
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-impact-test-'));
    try {
      mkdirSync(join(tempDir, 'src/core/auth'), { recursive: true });
      mkdirSync(join(tempDir, 'test'), { recursive: true });
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        name: 'impact-app',
        scripts: { test: 'vitest', lint: 'eslint .' },
      }));
      writeFileSync(join(tempDir, 'src/core/auth/session.ts'), 'export function createSession(token: string) { return token; }');
      writeFileSync(join(tempDir, 'src/core/routes.ts'), 'export const routes = ["/login"];');
      writeFileSync(join(tempDir, 'test/unit.test.ts'), 'import { describe } from "vitest";');

      const impact = analyzeChangeImpact(tempDir, 'How do I implement OAuth login?', '.');

      expect(impact.summary).toContain('OAuth');
      expect(impact.files.modify.some((file) => file.path === 'src/core/auth/session.ts')).toBe(true);
      expect(impact.files.create.some((file) => file.path.includes('OAuthProvider.ts'))).toBe(true);
      expect(impact.files.maybe.some((file) => file.path === 'package.json')).toBe(true);
      expect(impact.files.tests).toContain('test/unit.test.ts');
      expect(impact.suggestedOrder.join('\n')).toContain('npm run test');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('exposes project catalog and impact through read-only built-in tools', async () => {
    const { createProjectCatalogTool, createAnalyzeChangeImpactTool } = await import('../src/core/tools/builtinTools');
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-ask-tools-test-'));
    try {
      mkdirSync(join(tempDir, 'src'), { recursive: true });
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        name: 'tool-app',
        scripts: { test: 'vitest' },
      }));
      writeFileSync(join(tempDir, 'src/index.ts'), 'export const auth = true;');

      const catalog = await createProjectCatalogTool(tempDir).execute({});
      expect(catalog.success).toBe(true);
      expect(catalog.output).toContain('tool-app');

      const impact = await createAnalyzeChangeImpactTool(tempDir).execute({
        feature: 'How do I add auth?',
        scopeRoot: '.',
      });
      expect(impact.success).toBe(true);
      expect(impact.output).toContain('"files"');
      expect(readFileSync(join(tempDir, 'src/index.ts'), 'utf8')).toContain('auth');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('prepares a headless Ask run plan for SDK-compatible callers', async () => {
    const { AskOrchestrator } = await import('../src/core/ask');
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-ask-orchestrator-test-'));
    try {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'ask-app' }));

      const plan = AskOrchestrator.prepare('How do I implement rate limiting here?', {
        workspaceRoot: tempDir,
      });

      expect(plan.route.intent).toBe('implement_here');
      expect(plan.promptContext).toContain('## Ask routing');
      expect(plan.promptContext).toContain('analyze_change_impact');
      expect(plan.maxSteps).toBe(20);
      expect(plan.autoContinue).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('uses Ask step ceilings instead of overriding every intent with the setting', async () => {
    const { AskOrchestrator } = await import('../src/core/ask');

    expect(AskOrchestrator.prepare('Where is Ask mode defined?', {
      configuredMaxSteps: 18,
    }).maxSteps).toBe(8);

    expect(AskOrchestrator.prepare('Compare plan mode and ask mode', {
      configuredMaxSteps: 18,
    }).maxSteps).toBe(16);

    expect(AskOrchestrator.prepare('How do I implement OAuth here?', {
      configuredMaxSteps: 18,
    }).maxSteps).toBe(18);

    expect(AskOrchestrator.prepare('Explain ChatOrchestrator flow', {
      configuredMaxSteps: 50,
      askDepth: 'deep',
      askMaxAutoContinues: 3,
    })).toMatchObject({ maxSteps: 22, maxAutoContinues: 1 });
  });

  it('loads cached project catalogs during Ask preparation', async () => {
    const { AskOrchestrator } = await import('../src/core/ask');
    const tempDir = mkdtempSync(join(tmpdir(), 'thunder-ask-cached-catalog-test-'));
    try {
      mkdirSync(join(tempDir, '.mitii'), { recursive: true });
      writeFileSync(join(tempDir, '.mitii/projects.json'), JSON.stringify({
        workspaceRoot: tempDir,
        generatedAt: 'cached',
        projects: [
          { id: 'cached-docs', root: 'apps/docs', name: 'cached-docs', type: 'docs', entryFiles: [], scripts: {} },
        ],
      }));

      const plan = AskOrchestrator.prepare('How do docs work?', { workspaceRoot: tempDir });
      expect(plan.catalog?.generatedAt).toBe('cached');
      expect(plan.scope.scopeRoot).toBe('apps/docs');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('filters scoped search and retrieve_context tool results', async () => {
    const { createSearchTool, createRetrieveContextTool } = await import('../src/core/tools/builtinTools');
    const { ContextBudgeter } = await import('../src/core/context/ContextBudgeter');
    const fakeFts = {
      search: () => [
        { relPath: 'apps/docs/src/index.ts', snippet: 'docs result' },
        { relPath: 'apps/agent/src/index.ts', snippet: 'agent result' },
      ],
    };

    const searchResult = await createSearchTool(fakeFts as any).execute({
      query: 'index',
      scopeRoot: 'apps/docs',
    });

    expect(searchResult.output).toContain('apps/docs/src/index.ts');
    expect(searchResult.output).not.toContain('apps/agent/src/index.ts');

    const fakeRetriever = {
      retrieve: async (query: { scopeRoot?: string }) => [
        {
          id: 'scoped',
          source: 'fts',
          relPath: `${query.scopeRoot}/src/index.ts`,
          content: 'scoped context',
          score: 10,
          reason: 'test',
          tokenEstimate: 4,
        },
      ],
    };
    const contextResult = await createRetrieveContextTool(fakeRetriever as any, new ContextBudgeter()).execute({
      query: 'index',
      scopeRoot: 'apps/docs',
    });
    expect(contextResult.output).toContain('apps/docs/src/index.ts');
  });

  it('injects deep Ask instructions into prompts without applying concise global prose rules', async () => {
    const { buildPrompt, buildSystemPrompt } = await import('../src/core/planning/promptBuilder');

    const system = buildSystemPrompt('ask', true);
    expect(system).toContain('technical blog post');
    expect(system).toContain('analyze_change_impact');
    expect(system).not.toContain('Keep prose concise. Avoid filler');

    const messages = buildPrompt(
      'ask',
      { items: [], totalTokens: 0, formatted: 'repo context', retrievedCount: 0, budgetLimit: 100, dropped: [], truncatedCount: 0 },
      'Explain the architecture',
      [],
      true,
      false,
      false,
      undefined,
      undefined,
      false,
      undefined,
      '## Ask routing\nIntent: architecture'
    );

    expect(messages.at(-1)?.content).toContain('## Ask routing');
    expect(messages.at(-1)?.content).toContain('repo context');
  });
});

describe('SCM commit message generation', () => {
  it('redacts sensitive diff lines before prompting', async () => {
    const { buildCommitMessagePrompt } = await import('../src/core/scm');
    const prompt = buildCommitMessagePrompt({
      stagedDiff: [
        'diff --git a/.env b/.env',
        '+OPENAI_API_KEY=sk-secret',
        '+normal=value',
      ].join('\n'),
      changedFiles: ['.env'],
      recentCommits: ['aa2660f feat(ask): add structured ask mode'],
    });

    expect(prompt).toContain('[redacted sensitive line]');
    expect(prompt).not.toContain('sk-secret');
  });

  it('normalizes model output to a 72-character subject', async () => {
    const { normalizeCommitMessage } = await import('../src/core/scm');
    const result = normalizeCommitMessage('```text\nfeat(ask): add an extremely long subject that should be shortened because it will not fit in git history cleanly\n\nAdds details.\n```');

    expect(result.subject.length).toBeLessThanOrEqual(72);
    expect(result.fullMessage).toContain('Adds details.');
    expect(result.fullMessage).not.toContain('```');
  });

  it('generates a commit message through the configured provider', async () => {
    const { generateCommitMessage } = await import('../src/core/scm');
    const provider = {
      id: 'fake',
      capabilities: {
        contextWindow: 8192,
        supportsStreaming: true,
        supportsTools: false,
        supportsEmbeddings: false,
      },
      async *complete() {
        yield { content: 'feat(scm): generate commit messages' };
        yield { done: true };
      },
    };

    const result = await generateCommitMessage({
      stagedDiff: 'diff --git a/src/a.ts b/src/a.ts\n+export const a = 1;',
      changedFiles: ['src/a.ts'],
      recentCommits: [],
    }, provider);

    expect(result.fullMessage).toBe('feat(scm): generate commit messages');
  });

  it('rejects empty staged diffs', async () => {
    const { generateCommitMessage } = await import('../src/core/scm');
    const provider = {
      id: 'fake',
      capabilities: {
        contextWindow: 8192,
        supportsStreaming: true,
        supportsTools: false,
        supportsEmbeddings: false,
      },
      async *complete() {
        yield { content: 'chore: noop' };
      },
    };

    await expect(generateCommitMessage({
      stagedDiff: '',
      unstagedDiff: 'diff --git a/src/a.ts b/src/a.ts\n+unstaged',
      changedFiles: ['src/a.ts'],
      recentCommits: [],
    }, provider)).rejects.toThrow('No staged changes');
  });

  it('contributes the SCM title command with an icon', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      contributes: {
        commands: Array<{ command: string; icon?: string }>;
        menus?: Record<string, Array<{ command: string }>>;
        configuration: { properties: Record<string, unknown> };
      };
    };

    expect(pkg.contributes.commands.find((command) => command.command === 'thunder.generateCommitMessage')?.icon).toBe('media/mitii-activitybar.svg');
    expect((pkg as { activationEvents?: string[] }).activationEvents).toContain('onCommand:thunder.generateCommitMessage');
    expect(pkg.contributes.menus?.['scm/title']?.some((entry) => entry.command === 'thunder.generateCommitMessage')).toBe(true);
    expect(pkg.contributes.configuration.properties['thunder.scm.commitMessageEnabled']).toBeTruthy();
  });
});
