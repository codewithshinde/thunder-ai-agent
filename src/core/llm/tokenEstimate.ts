export function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token for English/code
  return Math.ceil(text.length / 4);
}

export async function estimateTokensAsync(text: string): Promise<number> {
  return estimateTokens(text);
}
