import type { ThunderDb } from './ThunderDb';

export interface Migration {
  version: number;
  name: string;
  up: (db: ThunderDb) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'create_files_table',
    up: (db) => {
      db.raw.exec(`
        CREATE TABLE IF NOT EXISTS files (
          id INTEGER PRIMARY KEY,
          workspace TEXT NOT NULL,
          path TEXT NOT NULL,
          rel_path TEXT NOT NULL,
          hash TEXT NOT NULL,
          size INTEGER NOT NULL,
          mtime INTEGER NOT NULL,
          language TEXT,
          indexed_at INTEGER,
          UNIQUE(workspace, rel_path)
        );
        CREATE INDEX IF NOT EXISTS idx_files_workspace ON files(workspace);
      `);
    },
  },
  {
    version: 2,
    name: 'create_chunks_table',
    up: (db) => {
      db.raw.exec(`
        CREATE TABLE IF NOT EXISTS chunks (
          id INTEGER PRIMARY KEY,
          file_id INTEGER NOT NULL,
          chunk_index INTEGER NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          content TEXT NOT NULL,
          token_estimate INTEGER NOT NULL,
          hash TEXT NOT NULL,
          FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id);
      `);
    },
  },
  {
    version: 3,
    name: 'create_fts_chunks',
    up: (db) => {
      db.raw.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
          rel_path,
          content,
          tokenize = 'trigram'
        );
      `);
    },
  },
  {
    version: 4,
    name: 'create_symbols_table',
    up: (db) => {
      db.raw.exec(`
        CREATE TABLE IF NOT EXISTS symbols (
          id INTEGER PRIMARY KEY,
          file_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          signature TEXT,
          start_line INTEGER NOT NULL,
          end_line INTEGER,
          parent_symbol_id INTEGER,
          FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_symbols_file_id ON symbols(file_id);
        CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      `);
    },
  },
  {
    version: 5,
    name: 'create_symbol_refs_table',
    up: (db) => {
      db.raw.exec(`
        CREATE TABLE IF NOT EXISTS symbol_refs (
          id INTEGER PRIMARY KEY,
          file_id INTEGER NOT NULL,
          symbol_name TEXT NOT NULL,
          line INTEGER NOT NULL,
          FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_symbol_refs_file_id ON symbol_refs(file_id);
        CREATE INDEX IF NOT EXISTS idx_symbol_refs_name ON symbol_refs(symbol_name);
      `);
    },
  },
  {
    version: 6,
    name: 'create_session_tables',
    up: (db) => {
      db.raw.exec(`
        CREATE TABLE IF NOT EXISTS agent_sessions (
          id TEXT PRIMARY KEY,
          workspace TEXT NOT NULL,
          title TEXT,
          mode TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_turns (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY(session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_turns_session ON agent_turns(session_id);
      `);
    },
  },
  {
    version: 7,
    name: 'create_task_plans_table',
    up: (db) => {
      db.raw.exec(`
        CREATE TABLE IF NOT EXISTS task_plans (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          goal TEXT NOT NULL,
          status TEXT NOT NULL,
          plan_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER
        );
      `);
    },
  },
  {
    version: 8,
    name: 'create_observations_table',
    up: (db) => {
      db.raw.exec(`
        CREATE TABLE IF NOT EXISTS observations (
          id INTEGER PRIMARY KEY,
          workspace TEXT NOT NULL,
          session_id TEXT NOT NULL,
          type TEXT NOT NULL,
          text TEXT NOT NULL,
          files_json TEXT,
          concepts_json TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_observations_workspace ON observations(workspace);
      `);
    },
  },
  {
    version: 9,
    name: 'create_approval_audit_table',
    up: (db) => {
      db.raw.exec(`
        CREATE TABLE IF NOT EXISTS approval_audit (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          input_json TEXT NOT NULL,
          decision TEXT NOT NULL,
          reason TEXT,
          created_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 10,
    name: 'create_checkpoints_table',
    up: (db) => {
      db.raw.exec(`
        CREATE TABLE IF NOT EXISTS checkpoints (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          workspace TEXT NOT NULL,
          kind TEXT NOT NULL,
          files_json TEXT NOT NULL,
          metadata_json TEXT,
          created_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 11,
    name: 'create_session_summaries_table',
    up: (db) => {
      db.raw.exec(`
        CREATE TABLE IF NOT EXISTS session_summaries (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          summary TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY(session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_session_summaries_session ON session_summaries(session_id);
      `);
    },
  },
  {
    version: 12,
    name: 'create_chunk_embeddings_table',
    up: (db) => {
      db.raw.exec(`
        CREATE TABLE IF NOT EXISTS chunk_embeddings (
          chunk_id INTEGER PRIMARY KEY,
          workspace TEXT NOT NULL,
          embedding_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_workspace ON chunk_embeddings(workspace);
      `);
    },
  },
];

export class MigrationRunner {
  constructor(private readonly db: ThunderDb) {}

  run(): void {
    this.db.raw.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);

    const applied = new Set(
      this.db.raw
        .prepare('SELECT version FROM schema_migrations')
        .all()
        .map((row) => (row as { version: number }).version)
    );

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) {
        continue;
      }
      this.db.transaction(() => {
        migration.up(this.db);
        this.db.raw
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, Date.now());
      });
    }
  }
}
