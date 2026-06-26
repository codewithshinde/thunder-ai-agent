export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface ChatDelta {
  content?: string;
  done?: boolean;
  error?: string;
}

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
