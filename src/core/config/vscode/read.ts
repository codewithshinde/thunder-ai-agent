import * as vscode from 'vscode';
import {
  ThunderConfigSchema,
  type ThunderConfig,
} from '../schema';
import { defaultThunderConfig } from '../defaults';
import { CONFIG_SECTION } from '../keys';

export function readThunderConfigFromSettings(): ThunderConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const raw = {
    debug: config.get<boolean>('debug'),
    provider: {
      type: config.get<string>('provider.type'),
      baseUrl: config.get<string>('provider.baseUrl'),
      model: config.get<string>('provider.model'),
      apiVersion: config.get<string>('provider.apiVersion'),
      region: config.get<string>('provider.region'),
      apiKeyRef: config.get<string>('provider.apiKeyRef'),
      contextWindow: config.get<number>('provider.contextWindow'),
      supportsStreaming: config.get<boolean>('provider.supportsStreaming'),
      supportsTools: config.get<boolean>('provider.supportsTools'),
      supportsEmbeddings: config.get<boolean>('provider.supportsEmbeddings'),
    },
    indexing: {
      enabled: config.get<boolean>('indexing.enabled'),
      autoIndexOnOpen: config.get<boolean>('indexing.autoIndexOnOpen'),
      maxFileSizeBytes: config.get<number>('indexing.maxFileSizeBytes'),
      hardSkipSizeBytes: config.get<number>('indexing.hardSkipSizeBytes'),
      respectGitignore: config.get<boolean>('indexing.respectGitignore'),
      respectThunderignore: config.get<boolean>('indexing.respectThunderignore'),
      maxConcurrency: config.get<number>('indexing.maxConcurrency'),
      treeSitterEnabled: config.get<boolean>('indexing.treeSitterEnabled'),
      vectorsEnabled: config.get<boolean>('indexing.vectorsEnabled'),
      embeddingProvider: config.get<string>('indexing.embeddingProvider'),
      vectorBackend: config.get<string>('indexing.vectorBackend'),
    },
    context: {
      rerankerEnabled: config.get<boolean>('context.rerankerEnabled'),
      rerankerCandidatePool: config.get<number>('context.rerankerCandidatePool'),
      rerankerTopK: config.get<number>('context.rerankerTopK'),
    },
    safety: {
      requireApprovalForWrites: config.get<boolean>('safety.requireApprovalForWrites'),
      requireApprovalForShell: config.get<boolean>('safety.requireApprovalForShell'),
      allowNetwork: config.get<boolean>('safety.allowNetwork'),
      blockDangerousCommands: config.get<boolean>('safety.blockDangerousCommands'),
      approvalMode: config.get<string>('safety.approvalMode'),
      autonomyPreset: config.get<string>('safety.autonomyPreset'),
      allowUntrustedWorkspace: config.get<boolean>('safety.allowUntrustedWorkspace'),
    },
    memory: {
      enabled: config.get<boolean>('memory.enabled'),
      maxItems: config.get<number>('memory.maxItems'),
      summarizeAfterTask: config.get<boolean>('memory.summarizeAfterTask'),
      hybridSearchEnabled: config.get<boolean>('memory.hybridSearchEnabled'),
    },
    agent: {
      subagentsEnabled: config.get<boolean>('agent.subagentsEnabled'),
      maxSteps: config.get<number>('agent.maxSteps'),
      askMaxSteps: config.get<number>('agent.askMaxSteps'),
      askDepth: config.get<string>('agent.askDepth'),
      planDepth: config.get<string>('agent.planDepth'),
      actDepth: config.get<string>('agent.actDepth'),
      askAutoContinue: config.get<boolean>('agent.askAutoContinue'),
      askMaxAutoContinues: config.get<number>('agent.askMaxAutoContinues'),
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
      verifyCommands: config.get<string[]>('agent.verifyCommands'),
      verifyOnActComplete: config.get<boolean>('agent.verifyOnActComplete'),
      planModel: config.get<string>('agent.planModel'),
      planBaseUrl: config.get<string>('agent.planBaseUrl'),
      planProviderType: config.get<string>('agent.planProviderType'),
      actModel: config.get<string>('agent.actModel'),
      actBaseUrl: config.get<string>('agent.actBaseUrl'),
      actProviderType: config.get<string>('agent.actProviderType'),
      checkpointStrategy: config.get<string>('agent.checkpointStrategy'),
    },
    mcp: {
      enabled: config.get<boolean>('mcp.enabled'),
      preloadBuiltin: config.get<boolean>('mcp.preloadBuiltin'),
      builtinServers: config.get<Record<string, unknown>>('mcp.builtinServers'),
      maxConcurrentStartup: config.get<number>('mcp.maxConcurrentStartup'),
      servers: config.get<Record<string, unknown>>('mcp.servers'),
    },
    workspace: {
      rootPathOverride: config.get<string>('workspace.rootPathOverride'),
    },
    scm: {
      commitMessageEnabled: config.get<boolean>('scm.commitMessageEnabled'),
    },
    github: {
      issueFetchEnabled: config.get<boolean>('github.issueFetchEnabled'),
      issueCommentLimit: config.get<number>('github.issueCommentLimit'),
      tokenRef: config.get<string>('github.tokenRef'),
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
