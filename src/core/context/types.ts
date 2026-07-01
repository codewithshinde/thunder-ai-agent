export interface ContextItem {
  id: string;
  source: string;
  relPath?: string;
  startLine?: number;
  endLine?: number;
  content: string;
  score: number;
  reason: string;
  tokenEstimate: number;
}

export interface PinnedContextRef {
  path: string;
  kind: 'file' | 'folder';
}

export interface ContextQuery {
  text: string;
  currentFile?: string;
  openFiles?: string[];
  gitDiffFiles?: string[];
  diagnosticFiles?: string[];
  pinnedContext?: PinnedContextRef[];
  scopeRoot?: string;
  maxItems?: number;
}

export interface ContextPack {
  items: ContextItem[];
  totalTokens: number;
  formatted: string;
  retrievedCount: number;
  budgetLimit: number;
  dropped: ContextDropInfo[];
  truncatedCount: number;
}

export interface ContextDropInfo {
  source: string;
  relPath?: string;
  reason: string;
  tokenEstimate: number;
  cause: 'over_budget' | 'not_selected';
}

export interface ContextSource {
  id: string;
  retrieve(query: ContextQuery): Promise<ContextItem[]>;
}

// Future extension points — no-op for MVP
export interface VectorIndex {
  enabled: boolean;
  search?(query: string, limit: number): Promise<ContextItem[]>;
  upsert?(items: unknown[]): Promise<void>;
  deleteByFile?(relPath: string): Promise<void>;
}

export const noopVectorIndex: VectorIndex = { enabled: false };

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

export interface RepoGraph {
  getRelatedFiles(path: string): Promise<Array<{ path: string; relation: string }>>;
}
