import { z } from 'zod';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { Tool, ToolResult } from './types';
import type { IgnoreService } from '../indexing/IgnoreService';
import type { FtsIndex } from '../indexing/FtsIndex';
import type { RepoMapService } from '../context/RepoMapService';
import type { GitService } from '../context/GitService';
import type { DiagnosticsService } from '../context/DiagnosticsService';
import type { HybridRetriever } from '../context/HybridRetriever';
import type { ContextBudgeter } from '../context/ContextBudgeter';

function blockedPath(relPath: string, ignoreService: IgnoreService): boolean {
  if (relPath.includes('..')) return true;
  return ignoreService.isIgnored(relPath);
}

export function createReadFileTool(workspace: string, ignoreService: IgnoreService): Tool<{ path: string }> {
  return {
    name: 'read_file',
    description: 'Read a workspace file',
    risk: 'low',
    inputSchema: z.object({ path: z.string() }),
    async execute(input): Promise<ToolResult> {
      if (blockedPath(input.path, ignoreService)) {
        return { success: false, output: '', error: 'Path is ignored or blocked' };
      }
      try {
        const content = readFileSync(join(workspace, input.path), 'utf-8');
        return { success: true, output: content.slice(0, 50000) };
      } catch (e) {
        return { success: false, output: '', error: String(e) };
      }
    },
  };
}

export function createListFilesTool(workspace: string, ignoreService: IgnoreService): Tool<{ path?: string }> {
  return {
    name: 'list_files',
    description: 'List files in a directory',
    risk: 'low',
    inputSchema: z.object({ path: z.string().optional() }),
    async execute(input): Promise<ToolResult> {
      const dirPath = input.path ?? '.';
      if (blockedPath(dirPath, ignoreService)) {
        return { success: false, output: '', error: 'Path is ignored or blocked' };
      }
      try {
        const dir = join(workspace, dirPath);
        const entries = readdirSync(dir).filter((e) => !ignoreService.isIgnored(join(dirPath, e).replace(/\\/g, '/')));
        return { success: true, output: entries.join('\n') };
      } catch (e) {
        return { success: false, output: '', error: String(e) };
      }
    },
  };
}

export function createSearchTool(fts: FtsIndex): Tool<{ query: string; limit?: number }> {
  return {
    name: 'search',
    description: 'Search indexed code via FTS',
    risk: 'low',
    inputSchema: z.object({ query: z.string(), limit: z.number().optional() }),
    async execute(input): Promise<ToolResult> {
      const results = fts.search(input.query, input.limit ?? 10);
      const output = results.map((r) => `${r.relPath}: ${r.snippet}`).join('\n');
      return { success: true, output: output || '(no results)' };
    },
  };
}

export function createRepoMapTool(repoMap: RepoMapService): Tool<{ query?: string }> {
  return {
    name: 'repo_map',
    description: 'Generate compact repo map',
    risk: 'low',
    inputSchema: z.object({ query: z.string().optional() }),
    async execute(input): Promise<ToolResult> {
      const map = repoMap.build({ query: input.query, maxChars: 6000 });
      return { success: true, output: map };
    },
  };
}

export function createRetrieveContextTool(retriever: HybridRetriever, budgeter: ContextBudgeter): Tool<{ query: string }> {
  return {
    name: 'retrieve_context',
    description: 'Build context pack for a query',
    risk: 'low',
    inputSchema: z.object({ query: z.string() }),
    async execute(input): Promise<ToolResult> {
      const items = await retriever.retrieve({ text: input.query });
      const pack = budgeter.budget(items, 4000);
      return { success: true, output: pack.formatted };
    },
  };
}

export function createGitDiffTool(git: GitService): Tool<Record<string, never>> {
  return {
    name: 'git_diff',
    description: 'Get git diff',
    risk: 'low',
    inputSchema: z.object({}),
    async execute(): Promise<ToolResult> {
      const diff = await git.getDiff();
      return { success: true, output: diff || '(no changes)' };
    },
  };
}

export function createDiagnosticsTool(diagnostics: DiagnosticsService): Tool<Record<string, never>> {
  return {
    name: 'diagnostics',
    description: 'Get VS Code diagnostics',
    risk: 'low',
    inputSchema: z.object({}),
    async execute(): Promise<ToolResult> {
      return { success: true, output: diagnostics.formatCompact() || '(no diagnostics)' };
    },
  };
}

export function createWriteFileTool(): Tool<{ path: string; content: string }> {
  return {
    name: 'write_file',
    description: 'Write a file (requires approval)',
    risk: 'high',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    async execute(input): Promise<ToolResult> {
      return { success: true, output: `Write to ${input.path} pending approval (${input.content.length} chars)` };
    },
  };
}

export function createApplyPatchTool(): Tool<{ path: string; oldText: string; newText: string }> {
  return {
    name: 'apply_patch',
    description: 'Apply a patch (requires approval)',
    risk: 'high',
    inputSchema: z.object({ path: z.string(), oldText: z.string(), newText: z.string() }),
    async execute(input): Promise<ToolResult> {
      return { success: true, output: `Patch for ${input.path} pending approval` };
    },
  };
}

export function createRunCommandTool(): Tool<{ command: string }> {
  return {
    name: 'run_command',
    description: 'Run a shell command (requires approval)',
    risk: 'high',
    inputSchema: z.object({ command: z.string() }),
    async execute(input): Promise<ToolResult> {
      return { success: true, output: `Command pending approval: ${input.command}` };
    },
  };
}

export function formatToolResult(toolName: string, result: ToolResult): string {
  if (!result.success) {
    return `Tool ${toolName} failed: ${result.error}`;
  }
  return `Tool ${toolName} result:\n${result.output}`;
}
