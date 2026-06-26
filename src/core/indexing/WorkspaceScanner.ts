import type { ThunderDb } from './ThunderDb';
import type { DiscoveredFile } from './FileDiscoveryService';
import { hashFile } from './hash';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('WorkspaceScanner');

export type ScanDiff = {
  added: DiscoveredFile[];
  changed: DiscoveredFile[];
  deleted: string[];
  unchanged: DiscoveredFile[];
};

export interface ScanProgress {
  phase: 'scanning' | 'diffing' | 'persisting' | 'done';
  processed: number;
  total: number;
}

export class WorkspaceScanner {
  constructor(
    private readonly db: ThunderDb,
    private readonly workspace: string
  ) {}

  computeDiff(discovered: DiscoveredFile[]): ScanDiff {
    const existing = this.db.raw
      .prepare('SELECT rel_path, hash, mtime FROM files WHERE workspace = ?')
      .all(this.workspace) as Array<{ rel_path: string; hash: string; mtime: number }>;

    const existingMap = new Map(existing.map((f) => [f.rel_path, f]));
    const discoveredSet = new Set(discovered.map((f) => f.relPath));

    const added: DiscoveredFile[] = [];
    const changed: DiscoveredFile[] = [];
    const unchanged: DiscoveredFile[] = [];
    const deleted: string[] = [];

    for (const file of discovered) {
      const prev = existingMap.get(file.relPath);
      if (!prev) {
        added.push(file);
      } else {
        const hash = hashFile(file.absPath);
        if (prev.hash !== hash || prev.mtime !== file.mtime) {
          changed.push(file);
        } else {
          unchanged.push(file);
        }
      }
    }

    for (const row of existing) {
      if (!discoveredSet.has(row.rel_path)) {
        deleted.push(row.rel_path);
      }
    }

    return { added, changed, deleted, unchanged };
  }

  persistScan(diff: ScanDiff): void {
    const insert = this.db.raw.prepare(`
      INSERT INTO files (workspace, path, rel_path, hash, size, mtime, language, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(workspace, rel_path) DO UPDATE SET
        path = excluded.path, hash = excluded.hash, size = excluded.size,
        mtime = excluded.mtime, language = excluded.language
    `);

    const deleteFile = this.db.raw.prepare(
      'DELETE FROM files WHERE workspace = ? AND rel_path = ?'
    );

    this.db.transaction(() => {
      for (const file of [...diff.added, ...diff.changed]) {
        const hash = hashFile(file.absPath);
        insert.run(
          this.workspace, file.absPath, file.relPath,
          hash, file.size, file.mtime, file.language
        );
      }
      for (const relPath of diff.deleted) {
        deleteFile.run(this.workspace, relPath);
      }
    });

    log.info('Scan persisted', {
      added: diff.added.length,
      changed: diff.changed.length,
      deleted: diff.deleted.length,
    });
  }

  getFileId(relPath: string): number | undefined {
    const row = this.db.raw
      .prepare('SELECT id FROM files WHERE workspace = ? AND rel_path = ?')
      .get(this.workspace, relPath) as { id: number } | undefined;
    return row?.id;
  }
}
