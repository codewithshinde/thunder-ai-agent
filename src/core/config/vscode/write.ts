import * as vscode from 'vscode';
import type {
  AgentSettingsPayload,
  IndexingSettingsPayload,
  ProviderSettingsPayload,
  SafetySettingsPayload,
  TelemetrySettingsPayload,
  ThunderSettingsPayload,
} from '../ui/payloads';
import { updateMcpSettings } from './mcpWrite';
import { CONFIG_SECTION } from '../keys';

export async function updateProviderSettings(settings: ProviderSettingsPayload): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const target = vscode.ConfigurationTarget.Global;

  await config.update('provider.type', settings.providerType, target);
  await config.update('provider.baseUrl', settings.baseUrl.trim(), target);
  await config.update('provider.model', settings.model.trim(), target);
  if (settings.apiVersion !== undefined) {
    await config.update('provider.apiVersion', settings.apiVersion.trim(), target);
  }
  if (settings.region !== undefined) {
    await config.update('provider.region', settings.region.trim(), target);
  }
  await config.update('provider.contextWindow', settings.contextWindow, target);
}

export async function updateAgentSettings(settings: AgentSettingsPayload): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const target = vscode.ConfigurationTarget.Global;

  await config.update('agent.subagentsEnabled', settings.subagentsEnabled, target);
  await config.update('agent.maxSteps', settings.maxSteps, target);
  await config.update('agent.askDepth', settings.askDepth, target);
  await config.update('agent.planDepth', settings.planDepth, target);
  await config.update('agent.actDepth', settings.actDepth, target);
  await config.update('agent.askMaxSteps', settings.askMaxSteps, target);
  await config.update('agent.askAutoContinue', settings.askAutoContinue, target);
  await config.update('agent.askMaxAutoContinues', settings.askMaxAutoContinues, target);
  await config.update('agent.autoContinue', settings.autoContinue, target);
  await config.update('agent.maxAutoContinues', settings.maxAutoContinues, target);
  await config.update('agent.researchAgentMaxSteps', settings.researchAgentMaxSteps, target);
  await config.update('agent.showDiffPreview', settings.showDiffPreview, target);
  await config.update('agent.planModel', settings.planModel.trim(), target);
  await config.update('agent.planBaseUrl', settings.planBaseUrl.trim(), target);
  await config.update('agent.actModel', settings.actModel.trim(), target);
  await config.update('agent.actBaseUrl', settings.actBaseUrl.trim(), target);
  await config.update('agent.checkpointStrategy', settings.checkpointStrategy, target);
}

export async function updateSafetySettings(settings: SafetySettingsPayload): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const target = vscode.ConfigurationTarget.Global;

  await config.update('safety.approvalMode', settings.approvalMode, target);
  await config.update('safety.requireApprovalForWrites', settings.requireApprovalForWrites, target);
  await config.update('safety.requireApprovalForShell', settings.requireApprovalForShell, target);
  await config.update('safety.autonomyPreset', settings.autonomyPreset, target);
}

export async function updateWorkspaceOverride(path: string): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update('workspace.rootPathOverride', path.trim(), vscode.ConfigurationTarget.Global);
}

export async function clearWorkspaceOverride(): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update('workspace.rootPathOverride', '', vscode.ConfigurationTarget.Global);
}

export { updateMcpSettings } from './mcpWrite';

export async function updateIndexingSettings(settings: IndexingSettingsPayload): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const target = vscode.ConfigurationTarget.Global;

  await config.update('indexing.vectorsEnabled', settings.vectorsEnabled, target);
  await config.update('indexing.embeddingProvider', settings.embeddingProvider, target);
  await config.update('indexing.vectorBackend', settings.vectorBackend, target);
  await config.update('memory.hybridSearchEnabled', settings.hybridMemorySearch, target);
}

export async function updateTelemetrySettings(settings: TelemetrySettingsPayload): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const target = vscode.ConfigurationTarget.Global;
  await config.update('telemetry.sessionLogging', settings.sessionLogging, target);
  await config.update('telemetry.debugMetrics', settings.debugMetrics, target);
}

export async function updateAllSettings(settings: ThunderSettingsPayload): Promise<void> {
  await updateProviderSettings(settings.provider);
  await updateAgentSettings(settings.agent);
  await updateSafetySettings(settings.safety);
  await updateMcpSettings(settings.mcp);
  await updateIndexingSettings(settings.indexing);
  await updateTelemetrySettings(settings.telemetry);
}
