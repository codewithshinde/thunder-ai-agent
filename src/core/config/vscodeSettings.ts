import * as vscode from 'vscode';
import {
  ThunderConfigSchema,
  type ThunderConfig,
  defaultThunderConfig,
} from './schema';

const CONFIG_SECTION = 'thunder';

export function readThunderConfigFromSettings(): ThunderConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const raw = {
    debug: config.get<boolean>('debug'),
    provider: {
      type: config.get<string>('provider.type'),
      baseUrl: config.get<string>('provider.baseUrl'),
      model: config.get<string>('provider.model'),
      apiKeyRef: config.get<string>('provider.apiKeyRef'),
      contextWindow: config.get<number>('provider.contextWindow'),
      supportsStreaming: config.get<boolean>('provider.supportsStreaming'),
      supportsTools: config.get<boolean>('provider.supportsTools'),
      supportsEmbeddings: config.get<boolean>('provider.supportsEmbeddings'),
    },
    indexing: {
      enabled: config.get<boolean>('indexing.enabled'),
      maxFileSizeBytes: config.get<number>('indexing.maxFileSizeBytes'),
      hardSkipSizeBytes: config.get<number>('indexing.hardSkipSizeBytes'),
      respectGitignore: config.get<boolean>('indexing.respectGitignore'),
      respectThunderignore: config.get<boolean>('indexing.respectThunderignore'),
      maxConcurrency: config.get<number>('indexing.maxConcurrency'),
      vectorsEnabled: config.get<boolean>('indexing.vectorsEnabled'),
    },
    safety: {
      requireApprovalForWrites: config.get<boolean>('safety.requireApprovalForWrites'),
      requireApprovalForShell: config.get<boolean>('safety.requireApprovalForShell'),
      allowNetwork: config.get<boolean>('safety.allowNetwork'),
      blockDangerousCommands: config.get<boolean>('safety.blockDangerousCommands'),
      approvalMode: config.get<string>('safety.approvalMode'),
      autonomyPreset: config.get<string>('safety.autonomyPreset'),
    },
    memory: {
      enabled: config.get<boolean>('memory.enabled'),
      maxItems: config.get<number>('memory.maxItems'),
      summarizeAfterTask: config.get<boolean>('memory.summarizeAfterTask'),
    },
    agent: {
      subagentsEnabled: config.get<boolean>('agent.subagentsEnabled'),
      maxSteps: config.get<number>('agent.maxSteps'),
      autoContinue: config.get<boolean>('agent.autoContinue'),
      maxAutoContinues: config.get<number>('agent.maxAutoContinues'),
      researchAgentMaxSteps: config.get<number>('agent.researchAgentMaxSteps'),
      researchAgentTimeoutMs: config.get<number>('agent.researchAgentTimeoutMs'),
      researchAgentModel: config.get<string>('agent.researchAgentModel'),
      researchAgentBaseUrl: config.get<string>('agent.researchAgentBaseUrl'),
      orchestrationEnabled: config.get<boolean>('agent.orchestrationEnabled'),
      stepMaxRetries: config.get<number>('agent.stepMaxRetries'),
      finalValidationEnabled: config.get<boolean>('agent.finalValidationEnabled'),
      showDiffPreview: config.get<boolean>('agent.showDiffPreview'),
    },
    mcp: {
      enabled: config.get<boolean>('mcp.enabled'),
      servers: config.get<Record<string, unknown>>('mcp.servers'),
    },
    workspace: {
      rootPathOverride: config.get<string>('workspace.rootPathOverride'),
    },
    telemetry: {
      sessionLogging: config.get<boolean>('telemetry.sessionLogging'),
      debugMetrics: config.get<boolean>('telemetry.debugMetrics'),
    },
  };

  const result = ThunderConfigSchema.safeParse(raw);
  if (result.success) {
    return result.data;
  }
  return defaultThunderConfig();
}
