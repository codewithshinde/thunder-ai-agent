import * as vscode from 'vscode';
import { AGENT_NAME } from '../../shared/brand';
import { createLogger } from '../telemetry/Logger';
import { readThunderConfigFromSettings } from './vscodeSettings';
import {
  updateProviderSettings,
  updateAgentSettings,
  updateSafetySettings,
  updateMcpSettings,
  updateAllSettings,
  updateWorkspaceOverride,
  clearWorkspaceOverride,
} from './updateSettings';
import { type ThunderConfig, defaultThunderConfig } from './schema';
import type {
  AgentSettingsPayload,
  McpSettingsPayload,
  ProviderSettingsPayload,
  SafetySettingsPayload,
  ThunderSettingsPayload,
} from '../../vscode/webview/messages';

const log = createLogger('ConfigService');
const WORKSPACE_OVERRIDE_STATE_KEY = 'thunder.workspace.rootPathOverride';

export class ConfigService {
  private config: ThunderConfig = defaultThunderConfig();
  private disposable: vscode.Disposable | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async initialize(): Promise<void> {
    this.config = readThunderConfigFromSettings();
    this.disposable = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('thunder')) {
        this.config = readThunderConfigFromSettings();
        log.info('Configuration reloaded');
      }
    });
  }

  getConfig(): ThunderConfig {
    return {
      ...this.config,
      workspace: {
        rootPathOverride: this.getWorkspaceOverride(),
      },
    };
  }

  /** Settings + globalState (globalState wins when settings empty — reliable without an open folder). */
  getWorkspaceOverride(): string {
    const fromSettings = this.config.workspace.rootPathOverride?.trim() ?? '';
    const fromState = this.context.globalState.get<string>(WORKSPACE_OVERRIDE_STATE_KEY)?.trim() ?? '';
    return fromSettings || fromState;
  }

  private async persistWorkspaceOverride(path: string): Promise<void> {
    await this.context.globalState.update(WORKSPACE_OVERRIDE_STATE_KEY, path);
    try {
      if (path) {
        await updateWorkspaceOverride(path);
      } else {
        await clearWorkspaceOverride();
      }
    } catch (error) {
      // Settings API can fail when no folder is open; globalState is the source of truth.
      log.warn('Could not write workspace override to VS Code settings', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getApiKey(ref?: string): Promise<string | undefined> {
    const keyRef = ref ?? this.config.provider.apiKeyRef;
    const value = await this.context.secrets.get(keyRef);
    return value ?? undefined;
  }

  async setApiKey(key: string, ref?: string): Promise<void> {
    const keyRef = ref ?? this.config.provider.apiKeyRef;
    await this.context.secrets.store(keyRef, key);
    log.info('API key stored securely', { ref: keyRef });
  }

  async updateProviderSettings(settings: ProviderSettingsPayload): Promise<void> {
    await updateProviderSettings(settings);
    this.config = readThunderConfigFromSettings();
    log.info('Provider settings updated');
  }

  async updateAgentSettings(settings: AgentSettingsPayload): Promise<void> {
    await updateAgentSettings(settings);
    this.config = readThunderConfigFromSettings();
    log.info('Agent settings updated');
  }

  async updateSafetySettings(settings: SafetySettingsPayload): Promise<void> {
    await updateSafetySettings(settings);
    this.config = readThunderConfigFromSettings();
    log.info('Safety settings updated');
  }

  async updateMcpSettings(settings: McpSettingsPayload): Promise<void> {
    await updateMcpSettings(settings);
    this.config = readThunderConfigFromSettings();
    log.info('MCP settings updated', { enabled: settings.enabled });
  }

  async updateAllSettings(settings: ThunderSettingsPayload): Promise<void> {
    await updateAllSettings(settings);
    this.config = readThunderConfigFromSettings();
    log.info(`All ${AGENT_NAME} settings updated`);
  }

  async setWorkspaceOverride(path: string): Promise<void> {
    await this.persistWorkspaceOverride(path.trim());
    this.config = readThunderConfigFromSettings();
    log.info('Workspace override updated', { path: path.trim() });
  }

  async clearWorkspaceOverride(): Promise<void> {
    await this.persistWorkspaceOverride('');
    this.config = readThunderConfigFromSettings();
    log.info('Workspace override cleared');
  }

  async deleteApiKey(ref?: string): Promise<void> {
    const keyRef = ref ?? this.config.provider.apiKeyRef;
    await this.context.secrets.delete(keyRef);
    log.info('API key deleted', { ref: keyRef });
  }

  dispose(): void {
    this.disposable?.dispose();
  }
}
