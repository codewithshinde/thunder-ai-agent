import type { ProviderType } from '../config/schema';
import { isCloudProvider } from './providerPresets';

export interface ProviderConnectionResult {
  ok: boolean;
  message: string;
  models?: string[];
}

export async function testOpenAiCompatibleConnection(
  baseUrl: string,
  model: string,
  apiKey?: string,
  options: {
    headers?: Record<string, string>;
    chatCompletionsPath?: string;
    queryParams?: Record<string, string>;
    authHeader?: 'authorization' | 'api-key' | 'x-api-key';
  } = {}
): Promise<ProviderConnectionResult> {
  const root = baseUrl.replace(/\/$/, '');
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (apiKey) {
    if (options.authHeader === 'api-key') {
      headers['api-key'] = apiKey;
    } else if (options.authHeader === 'x-api-key') {
      headers['x-api-key'] = apiKey;
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
  }

  try {
    if (!options.chatCompletionsPath) {
      const modelsRes = await fetch(`${root}/models`, { headers });
      if (modelsRes.ok) {
        const data = (await modelsRes.json()) as { data?: Array<{ id: string }> };
        const models = data.data?.map((m) => m.id) ?? [];
        const hasModel = models.length === 0 || models.some((m) => m === model || m.startsWith(model));
        if (!hasModel && models.length > 0) {
          return {
            ok: false,
            message: `Connected, but model "${model}" not found. Available: ${models.slice(0, 8).join(', ')}`,
            models,
          };
        }
        return {
          ok: true,
          message: `Connected to ${root}. Model "${model}"${models.length ? ' found' : ' (could not list models)'}.`,
          models,
        };
      }
    }

    const probeUrl = new URL(`${root}/${(options.chatCompletionsPath ?? 'chat/completions').replace(/^\//, '')}`);
    for (const [key, value] of Object.entries(options.queryParams ?? {})) {
      if (value) probeUrl.searchParams.set(key, value);
    }

    const probe = await fetch(probeUrl.toString(), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5,
        stream: false,
      }),
    });

    if (probe.ok) {
      return { ok: true, message: `Connected. Model "${model}" responded.` };
    }

    const errText = await probe.text().catch(() => '');
    if (probe.status === 404) {
      return { ok: false, message: `Model "${model}" not found.` };
    }
    return { ok: false, message: `Connection failed (${probe.status}): ${errText.slice(0, 150)}` };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return { ok: false, message: `Cannot reach ${root}. Check the endpoint is running.` };
    }
    return { ok: false, message: msg };
  }
}

export async function testAnthropicConnection(
  baseUrl: string,
  model: string,
  apiKey?: string
): Promise<ProviderConnectionResult> {
  if (!apiKey?.trim()) {
    return { ok: false, message: 'Anthropic requires an API key.' };
  }
  const root = baseUrl.replace(/\/$/, '');
  try {
    const response = await fetch(`${root}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    if (response.ok) {
      return { ok: true, message: `Connected to Anthropic. Model "${model}" responded.` };
    }
    const text = await response.text().catch(() => '');
    return { ok: false, message: `Anthropic error (${response.status}): ${text.slice(0, 150)}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function testGeminiConnection(
  baseUrl: string,
  model: string,
  apiKey?: string
): Promise<ProviderConnectionResult> {
  if (!apiKey?.trim()) {
    return { ok: false, message: 'Gemini requires an API key.' };
  }
  const root = baseUrl.replace(/\/$/, '');
  const url = new URL(`${root}/v1beta/models/${model}:generateContent`);
  url.searchParams.set('key', apiKey);
  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 8 },
      }),
    });
    if (response.ok) {
      return { ok: true, message: `Connected to Gemini. Model "${model}" responded.` };
    }
    const text = await response.text().catch(() => '');
    return { ok: false, message: `Gemini error (${response.status}): ${text.slice(0, 150)}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function testProviderConnection(
  providerType: ProviderType,
  baseUrl: string,
  model: string,
  apiKey?: string,
  apiVersion = '2024-10-21',
  region = 'us-east-1'
): Promise<ProviderConnectionResult> {
  if (providerType === 'echo') {
    return { ok: true, message: 'Echo mode — no network connection required.' };
  }
  if (providerType === 'anthropic') {
    return testAnthropicConnection(baseUrl, model, apiKey);
  }
  if (providerType === 'gemini') {
    return testGeminiConnection(baseUrl, model, apiKey);
  }
  if (providerType === 'bedrock') {
    return {
      ok: true,
      message: `AWS Bedrock configured for ${region}. Mitii will use the AWS default credential chain and model "${model}".`,
    };
  }
  if (isCloudProvider(providerType) && !apiKey?.trim()) {
    return { ok: false, message: `${providerType} requires an API key.` };
  }
  if (providerType === 'openrouter') {
    return testOpenAiCompatibleConnection(baseUrl, model, apiKey, {
      headers: {
        'HTTP-Referer': 'https://mitii.dev',
        'X-Title': 'Mitii Agent',
      },
    });
  }
  if (providerType === 'azure-openai') {
    return testOpenAiCompatibleConnection(baseUrl, model, apiKey, {
      authHeader: 'api-key',
      chatCompletionsPath: `openai/deployments/${encodeURIComponent(model)}/chat/completions`,
      queryParams: { 'api-version': apiVersion },
    });
  }
  return testOpenAiCompatibleConnection(baseUrl, model, apiKey);
}
