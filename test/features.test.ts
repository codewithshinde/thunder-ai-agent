import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defaultThunderConfig } from '../src/core/config/defaults';
import { applyAutonomyPreset, describeAutonomyPreset } from '../src/core/safety/autonomyPresets';
import { createProvider } from '../src/core/llm/createProvider';
import { OpenAiCompatibleProvider, sanitizeOpenAiCompatibleMessages } from '../src/core/llm/OpenAiCompatibleProvider';
import { PROVIDER_PRESETS, getProviderPreset, isCloudProvider } from '../src/core/llm/providerPresets';
import { LlmProviderRegistry } from '../src/core/llm/LlmProviderRegistry';
import { makeToolName } from '../src/core/mcp/McpManager';
import { resolveMcpAuthProvider } from '../src/core/mcp/McpOAuthProvider';
import { testProviderConnection } from '../src/core/llm/testConnection';
import { deriveSafetySettings } from '../src/webview-ui/src/utils/approvalMode';

describe('providerPresets', () => {
  it('includes all first-class providers', () => {
    const types = PROVIDER_PRESETS.map((p) => p.type);
    expect(types).toEqual(expect.arrayContaining([
      'openai',
      'openrouter',
      'azure-openai',
      'bedrock',
      'anthropic',
      'gemini',
      'deepseek',
      'cursor',
      'codex',
    ]));
  });

  it('resolves preset by type', () => {
    expect(getProviderPreset('anthropic')?.model).toContain('claude');
    expect(getProviderPreset('openrouter')?.baseUrl).toContain('openrouter');
    expect(getProviderPreset('azure-openai')?.model).toContain('deployment');
    expect(getProviderPreset('bedrock')?.model).toContain('anthropic.claude');
    expect(getProviderPreset('gemini')?.baseUrl).toContain('generativelanguage');
  });

  it('marks cloud providers correctly', () => {
    expect(isCloudProvider('anthropic')).toBe(true);
    expect(isCloudProvider('openai-compatible')).toBe(false);
    expect(isCloudProvider('echo')).toBe(false);
  });
});

describe('createProvider', () => {
  it('creates echo provider by default', () => {
    const provider = createProvider(defaultThunderConfig().provider);
    expect(provider.id).toBe('echo');
  });

  it('creates anthropic provider with correct id', () => {
    const provider = createProvider({
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-20250514',
      apiKeyRef: 'thunder.apiKey',
      contextWindow: 200_000,
      supportsStreaming: true,
      supportsTools: true,
      supportsEmbeddings: false,
    }, 'test-key');
    expect(provider.id).toBe('anthropic');
    expect(provider.capabilities.contextWindow).toBe(200_000);
  });

  it('creates gemini provider', () => {
    const provider = createProvider({
      ...defaultThunderConfig().provider,
      type: 'gemini',
      model: 'gemini-2.0-flash',
    });
    expect(provider.id).toBe('gemini');
  });

  it('routes deepseek through openai-compatible transport', () => {
    const provider = createProvider({
      ...defaultThunderConfig().provider,
      type: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    });
    expect(provider.id).toBe('openai-compatible');
  });

  it('creates native OpenRouter provider with provider-specific id', () => {
    const provider = createProvider({
      ...defaultThunderConfig().provider,
      type: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4',
    }, 'test-key');
    expect(provider.id).toBe('openrouter');
  });

  it('creates Azure OpenAI provider with provider-specific id', () => {
    const provider = createProvider({
      ...defaultThunderConfig().provider,
      type: 'azure-openai',
      baseUrl: 'https://example.openai.azure.com',
      model: 'my-deployment',
      apiVersion: '2024-10-21',
    }, 'test-key');
    expect(provider.id).toBe('azure-openai');
  });

  it('creates AWS Bedrock provider with tool support disabled', () => {
    const provider = createProvider({
      ...defaultThunderConfig().provider,
      type: 'bedrock',
      region: 'us-east-1',
      model: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
    });
    expect(provider.id).toBe('bedrock');
    expect(provider.capabilities.supportsTools).toBe(false);
  });
});

describe('sanitizeOpenAiCompatibleMessages', () => {
  it('preserves valid assistant tool-call groups', () => {
    const messages = sanitizeOpenAiCompatibleMessages([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'tc1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
        }],
      },
      { role: 'tool', content: 'file contents', tool_call_id: 'tc1', name: 'read_file' },
    ]);

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(messages[1].tool_calls).toHaveLength(1);
  });

  it('converts orphan tool messages into user context', () => {
    const messages = sanitizeOpenAiCompatibleMessages([
      { role: 'system', content: 'system' },
      { role: 'tool', content: 'file contents', tool_call_id: 'tc1', name: 'read_file' },
      { role: 'user', content: 'continue' },
    ]);

    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'user']);
    expect(messages[1].content).toContain('Tool result from read_file');
  });

  it('does not send partial tool-call groups to OpenAI-compatible providers', () => {
    const messages = sanitizeOpenAiCompatibleMessages([
      { role: 'user', content: 'inspect' },
      {
        role: 'assistant',
        content: 'I will read files.',
        tool_calls: [
          { id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
          { id: 'tc2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.ts"}' } },
        ],
      },
      { role: 'tool', content: 'a', tool_call_id: 'tc1', name: 'read_file' },
    ]);

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[1].tool_calls).toBeUndefined();
  });
});

describe('OpenAiCompatibleProvider', () => {
  it('sends the configured model in chat completion requests', async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://example.com/v1',
      model: 'devstral-small-2:24b',
      capabilities: { supportsTools: true },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      for await (const _delta of provider.complete({
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      })) {
        // consume stream
      }
    } finally {
      vi.unstubAllGlobals();
    }

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('devstral-small-2:24b');
    expect(body.model).not.toBe('qwen3.6:27b');
  });

  it('passes custom headers and reasoning options for native providers', async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4',
      apiKey: 'test-key',
      providerId: 'openrouter',
      defaultHeaders: { 'HTTP-Referer': 'https://mitii.dev', 'X-Title': 'Mitii Agent' },
      includeReasoning: true,
      capabilities: { supportsTools: true },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok', reasoning: 'thinking' }, finish_reason: 'stop' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const deltas = [];
    try {
      for await (const delta of provider.complete({
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      })) {
        deltas.push(delta);
      }
    } finally {
      vi.unstubAllGlobals();
    }

    const init = fetchMock.mock.calls[0][1];
    const body = JSON.parse(init.body);
    expect(init.headers['HTTP-Referer']).toBe('https://mitii.dev');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    expect(body.include_reasoning).toBe(true);
    expect(deltas.some((delta) => delta.reasoning === 'thinking')).toBe(true);
  });

  it('omits tool definitions when the configured model does not support tools', async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://example.com/v1',
      model: 'codestral:22b',
      capabilities: { supportsTools: false },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      for await (const _delta of provider.complete({
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        tools: [{
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file',
            parameters: { type: 'object', properties: {} },
          },
        }],
      })) {
        // consume stream
      }
    } finally {
      vi.unstubAllGlobals();
    }

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });
});

describe('LlmProviderRegistry', () => {
  it('resolves plan/act style overrides via resolveFromOptions', () => {
    const registry = new LlmProviderRegistry();
    const provider = registry.resolveFromOptions({
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4.1-mini',
      contextWindow: 128_000,
    }, 'sk-test');
    expect(provider.id).toBe('openai-compatible');
    expect(provider.capabilities.contextWindow).toBe(128_000);
  });
});

describe('autonomyPresets differentiation', () => {
  const base = defaultThunderConfig().safety;

  it('safe blocks network and requires all approvals', () => {
    const safe = applyAutonomyPreset(base, 'safe');
    expect(safe.allowNetwork).toBe(false);
    expect(safe.approvalMode).toBe('review_all');
    expect(safe.requireApprovalForWrites).toBe(true);
    expect(safe.requireApprovalForShell).toBe(true);
  });

  it('guided allows network and asks before edits', () => {
    const guided = applyAutonomyPreset(base, 'guided');
    expect(guided.allowNetwork).toBe(true);
    expect(guided.approvalMode).toBe('ask_edits');
    expect(guided.requireApprovalForWrites).toBe(true);
  });

  it('builder auto-approves writes but reviews shell', () => {
    const builder = applyAutonomyPreset(base, 'builder');
    expect(builder.requireApprovalForWrites).toBe(false);
    expect(builder.requireApprovalForShell).toBe(true);
    expect(builder.approvalMode).toBe('ask_commands');
  });

  it('enterprise blocks network like safe', () => {
    const enterprise = applyAutonomyPreset(base, 'enterprise');
    expect(enterprise.allowNetwork).toBe(false);
    expect(enterprise.approvalMode).toBe('review_all');
  });

  it('pilot auto-approves writes', () => {
    const pilot = applyAutonomyPreset(base, 'pilot');
    expect(pilot.requireApprovalForWrites).toBe(false);
    expect(pilot.requireApprovalForShell).toBe(true);
  });

  it('describes each preset', () => {
    expect(describeAutonomyPreset('guided')).toContain('Balanced');
    expect(describeAutonomyPreset('builder')).toContain('auto-approves writes');
  });
});

describe('deriveSafetySettings', () => {
  it('includes autonomy preset in payload', () => {
    expect(deriveSafetySettings('ask_edits').autonomyPreset).toBe('guided');
    expect(deriveSafetySettings('ask_commands').autonomyPreset).toBe('builder');
  });
});

describe('MCP remote transport helpers', () => {
  it('creates auth provider from bearer header', async () => {
    const provider = resolveMcpAuthProvider({ Authorization: 'Bearer test-token' });
    expect(provider).toBeDefined();
    const tokens = await provider!.tokens();
    expect(tokens?.access_token).toBe('test-token');
  });

  it('creates stable MCP tool names', () => {
    expect(makeToolName('My Server', 'read_file')).toMatch(/^mcp__/);
    expect(makeToolName('My Server', 'read_file').length).toBeLessThanOrEqual(128);
  });
});

describe('testProviderConnection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('echo mode always succeeds', async () => {
    const result = await testProviderConnection('echo', '', 'echo', undefined);
    expect(result.ok).toBe(true);
  });

  it('anthropic requires api key', async () => {
    const result = await testProviderConnection('anthropic', 'https://api.anthropic.com', 'claude', '');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('API key');
  });

  it('gemini requires api key', async () => {
    const result = await testProviderConnection('gemini', 'https://generativelanguage.googleapis.com', 'gemini-2.0-flash', '');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('API key');
  });

  it('cloud openai-compatible providers require api key', async () => {
    const result = await testProviderConnection('deepseek', 'https://api.deepseek.com/v1', 'deepseek-chat', '');
    expect(result.ok).toBe(false);
  });
});

describe('plan vs act config schema', () => {
  it('parses optional plan and act model overrides', () => {
    const config = defaultThunderConfig();
    expect(config.agent.planModel).toBe('');
    expect(config.agent.actModel).toBe('');
    expect(config.agent.checkpointStrategy).toBe('git-stash');
  });
});

describe('fetch_web tool policy', () => {
  it('is registered as read-only in tool policy', async () => {
    const { ToolPolicyEngine } = await import('../src/core/safety/ToolPolicyEngine');
    const engine = new ToolPolicyEngine(
      { ...defaultThunderConfig().safety, allowNetwork: true },
      () => false
    );
    const result = engine.evaluate('fetch_web', { url: 'https://example.com' });
    expect(result.decision).toBe('allow');
  });

  it('blocks fetch_web when network disabled', async () => {
    const { ToolPolicyEngine } = await import('../src/core/safety/ToolPolicyEngine');
    const engine = new ToolPolicyEngine(
      applyAutonomyPreset(defaultThunderConfig().safety, 'safe'),
      () => false
    );
    const result = engine.evaluate('fetch_web', { url: 'https://example.com' });
    expect(result.decision).toBe('block');
  });
});

describe('CheckpointService strategy metadata', () => {
  it('defaults to git-stash strategy in agent config', () => {
    expect(defaultThunderConfig().agent.checkpointStrategy).toBe('git-stash');
  });
});

describe('Anthropic message splitting', () => {
  it('maps tool results to anthropic format without throwing', async () => {
    const { AnthropicProvider } = await import('../src/core/llm/AnthropicProvider');
    const provider = new AnthropicProvider({
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'test',
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
          releaseLock: () => undefined,
        }),
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      for await (const _delta of provider.complete({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: '', tool_calls: [{
            id: 'tc1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
          }] },
          { role: 'tool', content: 'file contents', tool_call_id: 'tc1', name: 'read_file' },
        ],
        stream: true,
      })) {
        // consume stream
      }
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchMock).toHaveBeenCalled();
  });
});
