import type { ContextItem, ContextPack } from './types';

const BUDGET_SPLITS = {
  repoMap: 0.15,
  retrievedCode: 0.35,
  openDiff: 0.10,
  memory: 0.10,
  chat: 0.10,
  systemPlan: 0.20,
};

export class ContextBudgeter {
  budget(items: ContextItem[], maxTokens: number): ContextPack {
    const bySource = groupBySource(items);
    const budgeted: ContextItem[] = [];

    const allocations: Array<{ source: string; budget: number }> = [
      { source: 'repo-map', budget: maxTokens * BUDGET_SPLITS.repoMap },
      { source: 'fts', budget: maxTokens * BUDGET_SPLITS.retrievedCode * 0.6 },
      { source: 'current-editor', budget: maxTokens * BUDGET_SPLITS.openDiff * 0.5 },
      { source: 'open-files', budget: maxTokens * BUDGET_SPLITS.openDiff * 0.3 },
      { source: 'git-diff', budget: maxTokens * BUDGET_SPLITS.openDiff * 0.2 },
      { source: 'diagnostics', budget: maxTokens * BUDGET_SPLITS.openDiff * 0.2 },
      { source: 'memory', budget: maxTokens * BUDGET_SPLITS.memory },
    ];

    for (const { source, budget } of allocations) {
      const sourceItems = bySource.get(source) ?? [];
      let used = 0;
      for (const item of sourceItems) {
        if (used + item.tokenEstimate > budget) continue;
        budgeted.push(item);
        used += item.tokenEstimate;
      }
    }

    const totalTokens = budgeted.reduce((sum, i) => sum + i.tokenEstimate, 0);
    return {
      items: budgeted,
      totalTokens,
      formatted: formatContextPack(budgeted),
    };
  }
}

function groupBySource(items: ContextItem[]): Map<string, ContextItem[]> {
  const map = new Map<string, ContextItem[]>();
  for (const item of items) {
    const list = map.get(item.source) ?? [];
    list.push(item);
    map.set(item.source, list);
  }
  return map;
}

export function formatContextPack(items: ContextItem[]): string {
  return items
    .map((item) => `<!-- ${item.reason} -->\n${item.relPath ? `File: ${item.relPath}\n` : ''}${item.content}`)
    .join('\n\n---\n\n');
}
