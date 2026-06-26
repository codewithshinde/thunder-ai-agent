import type { ThunderDb } from '../indexing/ThunderDb';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('MemoryService');

export type ObservationType =
  | 'decision' | 'bugfix' | 'refactor' | 'architecture'
  | 'user_preference' | 'failed_attempt' | 'file_fact' | 'command_result';

export interface Observation {
  id: number;
  workspace: string;
  sessionId: string;
  type: ObservationType;
  text: string;
  files?: string[];
  concepts?: string[];
  createdAt: number;
}

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{10,}/,
  /Bearer\s+[a-zA-Z0-9._-]+/i,
  /api[_-]?key/i,
];

export class MemoryService {
  constructor(
    private readonly db: ThunderDb,
    private readonly workspace: string
  ) {}

  write(
    sessionId: string,
    type: ObservationType,
    text: string,
    files?: string[],
    concepts?: string[]
  ): Observation | null {
    const filtered = filterSecrets(text);
    if (!filtered) {
      log.warn('Blocked memory write containing secrets');
      return null;
    }

    const result = this.db.raw.prepare(`
      INSERT INTO observations (workspace, session_id, type, text, files_json, concepts_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.workspace, sessionId, type, filtered,
      files ? JSON.stringify(files) : null,
      concepts ? JSON.stringify(concepts) : null,
      Date.now()
    );

    return {
      id: Number(result.lastInsertRowid),
      workspace: this.workspace,
      sessionId,
      type,
      text: filtered,
      files,
      concepts,
      createdAt: Date.now(),
    };
  }

  search(query: string, limit = 10): Observation[] {
    const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
    if (terms.length === 0) return this.recent(limit);

    const rows = this.db.raw
      .prepare('SELECT * FROM observations WHERE workspace = ? ORDER BY created_at DESC LIMIT 100')
      .all(this.workspace) as Array<Record<string, unknown>>;

    return rows
      .map(rowToObservation)
      .filter((obs) => terms.some((t) => obs.text.toLowerCase().includes(t)))
      .slice(0, limit);
  }

  recent(limit = 10): Observation[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM observations WHERE workspace = ? ORDER BY created_at DESC LIMIT ?')
      .all(this.workspace, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToObservation);
  }

  delete(id: number): boolean {
    const result = this.db.raw.prepare('DELETE FROM observations WHERE id = ?').run(id);
    return result.changes > 0;
  }

  clear(): number {
    const result = this.db.raw.prepare('DELETE FROM observations WHERE workspace = ?').run(this.workspace);
    return result.changes;
  }
}

function filterSecrets(text: string): string | null {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) return null;
  }
  return text;
}

function rowToObservation(row: Record<string, unknown>): Observation {
  return {
    id: row.id as number,
    workspace: row.workspace as string,
    sessionId: row.session_id as string,
    type: row.type as ObservationType,
    text: row.text as string,
    files: row.files_json ? JSON.parse(row.files_json as string) : undefined,
    concepts: row.concepts_json ? JSON.parse(row.concepts_json as string) : undefined,
    createdAt: row.created_at as number,
  };
}
