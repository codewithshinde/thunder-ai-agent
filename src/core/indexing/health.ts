import type { ThunderDb } from './ThunderDb';

export interface DbHealthReport {
  ok: boolean;
  writable: boolean;
  ftsSupported: boolean;
  tables: string[];
  missingTables: string[];
  errors: string[];
}

const REQUIRED_TABLES = [
  'files',
  'chunks',
  'symbols',
  'symbol_refs',
  'agent_sessions',
  'agent_turns',
  'task_plans',
  'observations',
  'approval_audit',
  'checkpoints',
  'schema_migrations',
];

export function checkDbHealth(db: ThunderDb): DbHealthReport {
  const errors: string[] = [];
  const tables: string[] = [];
  let ftsSupported = false;
  let writable = false;

  try {
    const rows = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    tables.push(...rows.map((r) => r.name));

    const ftsRow = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fts_chunks'")
      .get();
    ftsSupported = ftsRow !== undefined;

    db.raw.prepare('CREATE TEMP TABLE IF NOT EXISTS _health_check (id INTEGER)').run();
    db.raw.prepare('DROP TABLE IF EXISTS _health_check').run();
    writable = true;
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  const missingTables = REQUIRED_TABLES.filter((t) => !tables.includes(t));

  return {
    ok: errors.length === 0 && missingTables.length === 0 && ftsSupported && writable,
    writable,
    ftsSupported,
    tables,
    missingTables,
    errors,
  };
}
