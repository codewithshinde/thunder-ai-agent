import type { AskScopeResolution, ProjectCatalog } from '../ask/askTypes';
import { resolveAskScope } from '../ask/AskScopeResolver';

export function resolvePlanScope(userMessage: string, catalog?: ProjectCatalog): AskScopeResolution {
  return resolveAskScope(userMessage, catalog);
}
