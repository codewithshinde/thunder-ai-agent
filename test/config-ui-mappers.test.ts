import { describe, expect, it } from 'vitest';
import {
  normalizeAgentSettings,
  normalizeProviderSettings,
  normalizeThunderSettings,
} from '../src/core/config/ui/mappers';
import type { AgentSettingsPayload, ThunderSettingsPayload } from '../src/core/config/ui/payloads';

const agentSettings = (overrides: Partial<AgentSettingsPayload> = {}): AgentSettingsPayload => ({
  subagentsEnabled: true,
  maxSteps: 15,
  askDepth: 'auto',
  planDepth: 'auto',
  actDepth: 'auto',
  askMaxSteps: 18,
  askAutoContinue: true,
  askMaxAutoContinues: 1,
  autoContinue: true,
  maxAutoContinues: 2,
  researchAgentMaxSteps: 10,
  showDiffPreview: false,
  planModel: '',
  planBaseUrl: '',
  actModel: '',
  actBaseUrl: '',
  checkpointStrategy: 'git-stash',
  ...overrides,
});

describe('config UI mappers', () => {
  it('normalizes provider settings before writing VS Code config', () => {
    expect(
      normalizeProviderSettings(
        {
          providerType: 'echo',
          baseUrl: '  http://localhost:11434/v1  ',
          model: '  echo-model  ',
          contextWindow: 10,
        },
        8192
      )
    ).toEqual({
      providerType: 'echo',
      baseUrl: 'http://localhost:11434/v1',
      model: 'echo-model',
      contextWindow: 1024,
    });
  });

  it('clamps agent setting counters and trims model overrides', () => {
    expect(
      normalizeAgentSettings(
        agentSettings({
          maxSteps: 101.8,
          askMaxSteps: 0,
          askMaxAutoContinues: 99,
          maxAutoContinues: Number.NaN,
          researchAgentMaxSteps: 50.9,
          planModel: '  planner  ',
          planBaseUrl: '  http://planner.local/v1  ',
          actModel: '  builder  ',
          actBaseUrl: '  http://builder.local/v1  ',
        })
      )
    ).toMatchObject({
      maxSteps: 100,
      askMaxSteps: 1,
      askMaxAutoContinues: 10,
      maxAutoContinues: 0,
      researchAgentMaxSteps: 50,
      planModel: 'planner',
      planBaseUrl: 'http://planner.local/v1',
      actModel: 'builder',
      actBaseUrl: 'http://builder.local/v1',
    });
  });

  it('normalizes full settings while keeping runtime MCP toggles authoritative', () => {
    const settings: ThunderSettingsPayload = {
      provider: {
        providerType: 'echo',
        baseUrl: ' http://localhost:11434/v1 ',
        model: ' qwen3-coder:30b ',
        contextWindow: 2048,
      },
      agent: agentSettings({ maxSteps: -1 }),
      safety: {
        approvalMode: 'review_all',
        requireApprovalForWrites: true,
        requireApprovalForShell: true,
        autonomyPreset: 'guided',
      },
      mcp: {
        enabled: true,
        builtinServers: {
          filesystem: false,
          memory: false,
          sequentialThinking: false,
        },
      },
      indexing: {
        vectorsEnabled: true,
        embeddingProvider: 'minilm',
        vectorBackend: 'sqlite',
        hybridMemorySearch: true,
      },
      telemetry: {
        sessionLogging: true,
        debugMetrics: false,
      },
    };

    expect(
      normalizeThunderSettings(settings, 8192, {
        filesystem: true,
        memory: false,
        sequentialThinking: true,
      })
    ).toMatchObject({
      provider: {
        baseUrl: 'http://localhost:11434/v1',
        model: 'qwen3-coder:30b',
        contextWindow: 2048,
      },
      agent: {
        maxSteps: 1,
      },
      mcp: {
        enabled: true,
        builtinServers: {
          filesystem: true,
          memory: false,
          sequentialThinking: true,
        },
      },
    });
  });
});
