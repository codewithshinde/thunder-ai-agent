import type { ToolDefinition } from './toolTypes';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required';
  reasoningEffort?: 'low' | 'medium' | 'high';
  includeReasoning?: boolean;
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface ChatDelta {
  content?: string;
  reasoning?: string;
  done?: boolean;
  error?: string;
  tool_calls?: ToolCallDelta[];
  finish_reason?: string;
}

export interface AssistantStreamDelta {
  content?: string;
  reasoning?: string;
}

export type AssistantStreamChunk = string | AssistantStreamDelta;

export interface ModelCapabilities {
  contextWindow: number;
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsEmbeddings: boolean;
}

export interface LlmProvider {
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  complete(request: ChatRequest): AsyncIterable<ChatDelta>;
  countTokens?(text: string): Promise<number>;
}
