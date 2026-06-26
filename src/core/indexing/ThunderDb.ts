import Database from 'better-sqlite3';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('ThunderDb');

export class ThunderDb {
  private db: Database.Database | undefined;

  constructor(private readonly dbPath: string) {}

  open(): void {
    if (this.db) {
      return;
    }
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    log.info('Database opened', { path: this.dbPath });
  }

  get raw(): Database.Database {
    if (!this.db) {
      throw new Error('Database not open');
    }
    return this.db;
  }

  transaction<T>(fn: () => T): T {
    return this.raw.transaction(fn)();
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = undefined;
      log.info('Database closed');
    }
  }

  isOpen(): boolean {
    return this.db !== undefined;
  }
}
