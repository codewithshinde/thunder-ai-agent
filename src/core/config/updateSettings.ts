import * as vscode from 'vscode';
import type { AgentSettingsPayload, ProviderSettingsPayload, SafetySettingsPayload } from '../../vscode/webview/messages';

const CONFIG_SECTION = 'thunder';

export async function updateProviderSettings(settings: ProviderSettingsPayload): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const target = vscode.ConfigurationTarget.Global;

  await config.update('provider.type', settings.providerType, target);
  await config.update('provider.baseUrl', settings.baseUrl.trim(), target);
  await config.update('provider.model', settings.model.trim(), target);
  await config.update('provider.contextWindow', settings.contextWindow, target);
}

export async function updateAgentSettings(settings: AgentSettingsPayload): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const target = vscode.ConfigurationTarget.Global;

  await config.update('agent.subagentsEnabled', settings.subagentsEnabled, target);
  await config.update('agent.maxSteps', settings.maxSteps, target);
  await config.update('agent.autoContinue', settings.autoContinue, target);
  await config.update('agent.maxAutoContinues', settings.maxAutoContinues, target);
  await config.update('agent.researchAgentMaxSteps', settings.researchAgentMaxSteps, target);
  await config.update('agent.showDiffPreview', settings.showDiffPreview, target);
}

export async function updateSafetySettings(settings: SafetySettingsPayload): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const target = vscode.ConfigurationTarget.Global;

  await config.update('safety.approvalMode', settings.approvalMode, target);
  await config.update('safety.requireApprovalForWrites', settings.requireApprovalForWrites, target);
  await config.update('safety.requireApprovalForShell', settings.requireApprovalForShell, target);
}

export async function updateWorkspaceOverride(path: string): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update('workspace.rootPathOverride', path.trim(), vscode.ConfigurationTarget.Global);
}

export async function clearWorkspaceOverride(): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update('workspace.rootPathOverride', '', vscode.ConfigurationTarget.Global);
}
