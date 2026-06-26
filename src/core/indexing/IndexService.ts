import { ThunderDb } from './ThunderDb';
import { MigrationRunner } from './migrations';
import { ensureThunderDir, resolveDbPath } from './paths';
import { checkDbHealth, type DbHealthReport } from './health';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('IndexService');

export class IndexService {
  private db: ThunderDb | undefined;

  constructor(private readonly workspacePath: string) {}

  async initialize(): Promise<DbHealthReport> {
    if (!this.workspacePath) {
      throw new Error('No workspace path');
    }

    ensureThunderDir(this.workspacePath);
    const dbPath = resolveDbPath(this.workspacePath);
    this.db = new ThunderDb(dbPath);
    this.db.open();

    const runner = new MigrationRunner(this.db);
    runner.run();

    const health = checkDbHealth(this.db);
    if (!health.ok) {
      log.warn('Database health check issues', {
        missingTables: health.missingTables,
        ftsSupported: health.ftsSupported,
      });
    } else {
      log.info('Database initialized and healthy');
    }

    return health;
  }

  getDb(): ThunderDb | undefined {
    return this.db;
  }

  dispose(): void {
    this.db?.close();
    this.db = undefined;
  }
}
