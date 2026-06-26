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

export interface ContextQuery {
  text: string;
  currentFile?: string;
  openFiles?: string[];
  gitDiffFiles?: string[];
  diagnosticFiles?: string[];
  maxItems?: number;
}

export interface ContextPack {
  items: ContextItem[];
  totalTokens: number;
  formatted: string;
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
