export function normalizeScopeRoot(scopeRoot?: string): string | undefined {
  const normalized = scopeRoot?.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/g, '').trim();
  if (!normalized || normalized === '.') return undefined;
  if (normalized.includes('..')) return undefined;
  return normalized;
}

export function isPathInScope(relPath: string | undefined, scopeRoot?: string): boolean {
  const scope = normalizeScopeRoot(scopeRoot);
  if (!scope || !relPath) return true;
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return normalized === scope || normalized.startsWith(`${scope}/`);
}

export function filterItemsToScope<T extends { relPath?: string }>(items: T[], scopeRoot?: string): T[] {
  const scope = normalizeScopeRoot(scopeRoot);
  if (!scope) return items;
  return items.filter((item) => isPathInScope(item.relPath, scope));
}
