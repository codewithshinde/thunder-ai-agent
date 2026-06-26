import { z } from 'zod';
import { readFileSync, readdirSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { Tool, ToolResult } from './types';
import type { IgnoreService } from '../indexing/IgnoreService';
import type { FtsIndex } from '../indexing/FtsIndex';
import type { RepoMapService } from '../context/RepoMapService';
import type { GitService } from '../context/GitService';
import type { DiagnosticsService } from '../context/DiagnosticsService';
import type { HybridRetriever } from '../context/HybridRetriever';
import type { ContextBudgeter } from '../context/ContextBudgeter';
import type { MemoryService } from '../memory/MemoryService';
import { PatchApplyService } from '../apply/PatchApplyService';
import { isDangerousCommand } from '../safety/ToolPolicyEngine';
import { isReadOnlyCommand } from '../planning/PlanActEngine';
import { normalizeRelPath } from '../vscode/pathUtils';
import { ResearchAgent } from '../agent/ResearchAgent';
import type { SubagentTracker } from '../agent/SubagentTracker';
import type { LlmProvider } from '../llm/types';
import type { ToolDefinition } from '../llm/toolTypes';
import type { ToolExecutor } from '../safety/ToolExecutor';
import { createLogger } from '../telemetry/Logger';

const execAsync = promisify(exec);
const log = createLogger('BuiltinTools');

export interface ResearchAgentRuntime {
  toolExecutor: ToolExecutor;
  getProvider: () => LlmProvider | undefined;
  getTools: () => ToolDefinition[];
}

let researchAgentRuntime: ResearchAgentRuntime | undefined;
let researchAgent: ResearchAgent | undefined;
let subagentTracker: SubagentTracker | undefined;

export function setSubagentTracker(tracker: SubagentTracker | undefined): void {
  subagentTracker = tracker;
}

export function setResearchAgentRuntime(runtime: ResearchAgentRuntime | undefined): void {
  researchAgentRuntime = runtime;
  researchAgent = runtime ? new ResearchAgent(runtime.toolExecutor, 10) : undefined;
}

function blockedPath(relPath: string, ignoreService: IgnoreService): boolean {
  if (relPath.includes('..')) return true;
  return ignoreService.isIgnored(relPath);
}

function resolveToolPath(_workspace: string, rawPath: string, ignoreService: IgnoreService): string | null {
  const relPath = normalizeRelPath(rawPath);
  if (!relPath) return null;
  if (blockedPath(relPath, ignoreService)) return null;
  return relPath;
}

export function createReadFileTool(workspace: string, ignoreService: IgnoreService): Tool<{ path: string }> {
  return {
    name: 'read_file',
    description: 'Read one workspace file. For multiple files, prefer read_files in a single call.',
    risk: 'low',
    inputSchema: z.object({ path: z.string() }),
    async execute(input): Promise<ToolResult> {
      return readSingleFile(workspace, input.path, ignoreService);
    },
  };
}

export function createReadFilesTool(workspace: string, ignoreService: IgnoreService): Tool<{ paths: string[] }> {
  return {
    name: 'read_files',
    description: 'Read multiple workspace files in one call. Batch independent reads together.',
    risk: 'low',
    inputSchema: z.object({ paths: z.array(z.string()).min(1).max(12) }),
    async execute(input): Promise<ToolResult> {
      const parts: string[] = [];
      for (const path of input.paths.slice(0, 12)) {
        const result = await readSingleFile(workspace, path, ignoreService);
        parts.push(result.success
          ? `### ${path}\n${result.output}`
          : `### ${path}\nERROR: ${result.error}`);
      }
      return { success: true, output: parts.join('\n\n') };
    },
  };
}

async function readSingleFile(
  workspace: string,
  rawPath: string,
  ignoreService: IgnoreService
): Promise<ToolResult> {
  const relPath = resolveToolPath(workspace, rawPath, ignoreService);
  if (!relPath) {
    return { success: false, output: '', error: 'Invalid or ignored path — use a file path like src/index.ts' };
  }
  try {
    const content = readFileSync(join(workspace, relPath), 'utf-8');
    return { success: true, output: content.slice(0, 50000) };
  } catch (e) {
    return { success: false, output: '', error: String(e) };
  }
}

export function createListFilesTool(
  workspace: string,
  ignoreService: IgnoreService
): Tool<{ path?: string; recursive?: boolean }> {
  return {
    name: 'list_files',
    description: 'List files in a directory. Set recursive:true to walk subdirectories (max depth 8).',
    risk: 'low',
    inputSchema: z.object({ path: z.string().optional(), recursive: z.boolean().optional() }),
    async execute(input): Promise<ToolResult> {
      const dirPath = normalizeRelPath(input.path);
      if (dirPath && blockedPath(dirPath, ignoreService)) {
        return { success: false, output: '', error: 'Path is ignored or blocked' };
      }
      const listRel = dirPath || '.';
      try {
        const base = dirPath ? join(workspace, dirPath) : workspace;
        if (!input.recursive) {
          const entries = readdirSync(base).filter(
            (e) => !ignoreService.isIgnored(join(listRel, e).replace(/\\/g, '/'))
          );
          return { success: true, output: entries.join('\n') };
        }
        const files = walkDir(workspace, listRel, ignoreService, 8, 500);
        return { success: true, output: files.join('\n') || '(empty)' };
      } catch (e) {
        return { success: false, output: '', error: String(e) };
      }
    },
  };
}

function walkDir(
  workspace: string,
  relDir: string,
  ignoreService: IgnoreService,
  maxDepth: number,
  maxFiles: number
): string[] {
  const results: string[] = [];
  const walk = (currentRel: string, depth: number): void => {
    if (results.length >= maxFiles || depth > maxDepth) return;
    const abs = join(workspace, currentRel === '.' ? '' : currentRel);
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      const childRel = currentRel === '.' ? entry : `${currentRel}/${entry}`;
      if (ignoreService.isIgnored(childRel)) continue;
      const childAbs = join(workspace, childRel);
      let st;
      try {
        st = statSync(childAbs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(childRel, depth + 1);
      } else {
        results.push(childRel);
      }
    }
  };
  walk(relDir, 0);
  return results;
}

async function ripgrepSearch(workspace: string, query: string, limit: number): Promise<string | null> {
  try {
    const rg = await import('@vscode/ripgrep');
    const rgPath = rg.rgPath;
    const { stdout } = await execAsync(
      `"${rgPath}" --no-heading --line-number --max-count ${limit} --regexp ${JSON.stringify(query)} .`,
      { cwd: workspace, maxBuffer: 2 * 1024 * 1024, timeout: 15000 }
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export function createSearchTool(fts: FtsIndex, workspace?: string): Tool<{ query: string; limit?: number }> {
  return {
    name: 'search',
    description: 'Search code (FTS + ripgrep). For multiple patterns, use search_batch in one call.',
    risk: 'low',
    inputSchema: z.object({ query: z.string(), limit: z.number().optional() }),
    async execute(input): Promise<ToolResult> {
      const output = await runSearch(fts, workspace, input.query, input.limit ?? 10);
      return { success: true, output: output || '(no results)' };
    },
  };
}

export function createSearchBatchTool(fts: FtsIndex, workspace?: string): Tool<{ queries: string[]; limit?: number }> {
  return {
    name: 'search_batch',
    description: 'Run multiple code searches in parallel. Batch all independent search patterns in one call.',
    risk: 'low',
    inputSchema: z.object({
      queries: z.array(z.string()).min(1).max(10),
      limit: z.number().optional(),
    }),
    async execute(input): Promise<ToolResult> {
      const limit = input.limit ?? 8;
      const results = await Promise.all(
        input.queries.slice(0, 10).map(async (query) => {
          const output = await runSearch(fts, workspace, query, limit);
          return `## Query: ${query}\n${output || '(no results)'}`;
        })
      );
      return { success: true, output: results.join('\n\n') };
    },
  };
}

async function runSearch(
  fts: FtsIndex,
  workspace: string | undefined,
  query: string,
  limit: number
): Promise<string> {
  const ftsResults = fts.search(query, limit);
  let output = ftsResults.map((r) => `${r.relPath}: ${r.snippet}`).join('\n');

  if ((!output || ftsResults.length < 3) && workspace) {
    const rgOut = await ripgrepSearch(workspace, query, limit);
    if (rgOut) {
      output = output ? `${output}\n--- ripgrep ---\n${rgOut}` : rgOut;
    }
  }
  return output;
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

export function createMemorySearchTool(memory: MemoryService): Tool<{ query: string; limit?: number }> {
  return {
    name: 'memory_search',
    description: 'Search long-term memory observations',
    risk: 'low',
    inputSchema: z.object({ query: z.string(), limit: z.number().optional() }),
    async execute(input): Promise<ToolResult> {
      const results = memory.search(input.query, input.limit ?? 10);
      const output = results.map((r) => `[${r.type}] ${r.text}`).join('\n');
      return { success: true, output: output || '(no memories)' };
    },
  };
}

export function createMemoryWriteTool(
  memory: MemoryService,
  getSessionId: () => string
): Tool<{ type: string; text: string; files?: string[] }> {
  return {
    name: 'memory_write',
    description: 'Save an observation to long-term memory',
    risk: 'medium',
    inputSchema: z.object({
      type: z.string(),
      text: z.string(),
      files: z.array(z.string()).optional(),
    }),
    async execute(input): Promise<ToolResult> {
      const obs = memory.write(getSessionId(), input.type as 'decision', input.text, input.files);
      if (!obs) {
        return { success: false, output: '', error: 'Memory write blocked (secrets or invalid)' };
      }
      return { success: true, output: `Saved memory #${obs.id}` };
    },
  };
}

export function createWriteFileTool(workspace: string, ignoreService: IgnoreService): Tool<{ path: string; content: string }> {
  return {
    name: 'write_file',
    description: 'Write a file (requires approval)',
    risk: 'high',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    async execute(input): Promise<ToolResult> {
      const relPath = resolveToolPath(workspace, input.path, ignoreService);
      if (!relPath) {
        return { success: false, output: '', error: 'Invalid or ignored path' };
      }
      try {
        const fullPath = join(workspace, relPath);
        writeFileSync(fullPath, input.content, 'utf-8');
        return { success: true, output: `Wrote ${input.content.length} chars to ${relPath}` };
      } catch (e) {
        return { success: false, output: '', error: String(e) };
      }
    },
  };
}

export function createApplyPatchTool(workspace: string, ignoreService: IgnoreService): Tool<{ path: string; oldText: string; newText: string }> {
  const patchService = new PatchApplyService(workspace);
  return {
    name: 'apply_patch',
    description: 'Apply a targeted text replacement patch (requires approval)',
    risk: 'high',
    inputSchema: z.object({ path: z.string(), oldText: z.string(), newText: z.string() }),
    async execute(input): Promise<ToolResult> {
      const relPath = resolveToolPath(workspace, input.path, ignoreService);
      if (!relPath) {
        return { success: false, output: '', error: 'Invalid or ignored path' };
      }
      const result = patchService.apply({
        path: relPath,
        oldText: input.oldText,
        newText: input.newText,
      });
      if (!result.success) {
        return { success: false, output: '', error: result.error ?? 'Patch failed' };
      }
      const note = result.proposedContent
        ? `Patch validated (${result.proposedContent.length} chars)`
        : `Patched ${relPath}`;
      return { success: true, output: note };
    },
  };
}

export function createRunCommandTool(workspace: string, getMode: () => string): Tool<{ command: string }> {
  return {
    name: 'run_command',
    description: 'Run a shell command in the workspace. Read-only commands (grep, depcheck, npm ls) work in Plan mode.',
    risk: 'high',
    inputSchema: z.object({ command: z.string() }),
    async execute(input): Promise<ToolResult> {
      if (isDangerousCommand(input.command)) {
        return { success: false, output: '', error: 'Dangerous command blocked' };
      }
      const mode = getMode();
      if (mode !== 'act' && !isReadOnlyCommand(input.command)) {
        return {
          success: false,
          output: '',
          error: 'Only read-only inspection commands are allowed in Plan/Review mode',
        };
      }
      try {
        const { stdout, stderr } = await execAsync(input.command, {
          cwd: workspace,
          maxBuffer: 1024 * 1024,
          timeout: 120000,
          env: { ...process.env, FORCE_COLOR: '0' },
        });
        const output = [stdout, stderr].filter(Boolean).join('\n').slice(0, 50000);
        log.info('Command executed', { command: input.command.slice(0, 80) });
        return { success: true, output: output || '(no output)' };
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        const output = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n').slice(0, 50000);
        return { success: false, output, error: err.message ?? 'Command failed' };
      }
    },
  };
}

export function createSpawnResearchAgentTool(): Tool<{ task: string; focus?: string }> {
  return {
    name: 'spawn_research_agent',
    description:
      'Delegate focused read-only research to a subagent. Spawn multiple in one turn for parallel analysis (deps, unused files, assets). Returns a concise report.',
    risk: 'low',
    inputSchema: z.object({
      task: z.string(),
      focus: z.string().optional(),
    }),
    async execute(input): Promise<ToolResult> {
      if (!researchAgentRuntime || !researchAgent) {
        return { success: false, output: '', error: 'Research agent not configured' };
      }
      const provider = researchAgentRuntime.getProvider();
      if (!provider) {
        return { success: false, output: '', error: 'No LLM provider available' };
      }
      const runId = subagentTracker?.start(input.task, input.focus);
      try {
        const report = await researchAgent.run(
          provider,
          input.task,
          input.focus,
          researchAgentRuntime.getTools()
        );
        if (runId) subagentTracker?.finish(runId, report);
        return { success: true, output: report };
      } catch (e) {
        const err = String(e);
        if (runId) subagentTracker?.fail(runId, err);
        return { success: false, output: '', error: err };
      }
    },
  };
}

export function formatToolResult(toolName: string, result: ToolResult): string {
  if (!result.success) {
    return `Tool ${toolName} failed: ${result.error}`;
  }
  return `Tool ${toolName} result:\n${result.output}`;
}
