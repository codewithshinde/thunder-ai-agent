export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: 'auth' | 'network' | 'model' | 'parse' | 'unknown',
    readonly statusCode?: number
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function normalizeProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('api key')) {
      return new ProviderError('Authentication failed. Check your API key.', 'auth', 401);
    }
    if (msg.includes('fetch') || msg.includes('network') || msg.includes('econnrefused')) {
      return new ProviderError('Network error. Check the provider URL and connection.', 'network');
    }
    if (msg.includes('404') || msg.includes('model')) {
      return new ProviderError('Model not found. Check the configured model name.', 'model', 404);
    }
    return new ProviderError(error.message, 'unknown');
  }

  return new ProviderError('An unknown provider error occurred', 'unknown');
}
