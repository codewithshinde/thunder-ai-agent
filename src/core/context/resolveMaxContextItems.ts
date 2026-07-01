import type { ActDepth } from '../modes/agent/actTypes';

export interface ResolveMaxContextItemsOptions {
  contextWindow: number;
  actDepth?: ActDepth;
  expandedQuery?: boolean;
}

export function resolveMaxContextItems({
  contextWindow,
  actDepth = 'auto',
  expandedQuery = false,
}: ResolveMaxContextItemsOptions): number {
  const base = expandedQuery ? 40 : 28;
  const normalizedWindow = Math.max(8192, Math.floor(contextWindow || 8192));
  const windowBonus = Math.floor((normalizedWindow - 8192) / 16_384);
  const depthBonus = actDepth === 'deep' ? 12 : actDepth === 'quick' ? -8 : 0;
  return Math.max(12, Math.min(80, base + windowBonus + depthBonus));
}
