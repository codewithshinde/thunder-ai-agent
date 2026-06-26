import { randomUUID } from 'crypto';
import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import type { ThunderDb } from '../indexing/ThunderDb';
import { resolveCheckpointDir } from '../indexing/paths';
import type { GitService } from '../context/GitService';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('CheckpointService');

export interface Checkpoint {
  id: string;
  sessionId: string;
  workspace: string;
  kind: 'pre-write' | 'manual';
  files: string[];
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export class CheckpointService {
  constructor(
    private readonly db: ThunderDb,
    private readonly workspace: string,
    private readonly gitService?: GitService
  ) {}

  async create(sessionId: string, files: string[], kind: Checkpoint['kind'] = 'pre-write'): Promise<Checkpoint> {
    const id = randomUUID();
    const checkpointDir = resolveCheckpointDir(this.workspace, id);
    mkdirSync(checkpointDir, { recursive: true });

    for (const relPath of files) {
      const src = join(this.workspace, relPath);
      if (!existsSync(src)) continue;
      const dest = join(checkpointDir, relPath);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }

    const metadata: Record<string, unknown> = {};
    if (this.gitService) {
      metadata.branch = await this.gitService.getCurrentBranch();
      metadata.diff = (await this.gitService.getDiff(2000)).slice(0, 2000);
    }

    const checkpoint: Checkpoint = {
      id,
      sessionId,
      workspace: this.workspace,
      kind,
      files,
      metadata,
      createdAt: Date.now(),
    };

    this.db.raw.prepare(`
      INSERT INTO checkpoints (id, session_id, workspace, kind, files_json, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, sessionId, this.workspace, kind,
      JSON.stringify(files), JSON.stringify(metadata), checkpoint.createdAt
    );

    log.info('Checkpoint created', { id, files: files.length });
    return checkpoint;
  }

  restore(checkpointId: string): boolean {
    const row = this.db.raw
      .prepare('SELECT files_json FROM checkpoints WHERE id = ?')
      .get(checkpointId) as { files_json: string } | undefined;

    if (!row) return false;

    const files = JSON.parse(row.files_json) as string[];
    const checkpointDir = resolveCheckpointDir(this.workspace, checkpointId);

    for (const relPath of files) {
      const src = join(checkpointDir, relPath);
      const dest = join(this.workspace, relPath);
      if (!existsSync(src)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(src));
    }

    log.info('Checkpoint restored', { id: checkpointId });
    return true;
  }

  list(sessionId?: string): Checkpoint[] {
    const rows = sessionId
      ? this.db.raw.prepare('SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC').all(sessionId)
      : this.db.raw.prepare('SELECT * FROM checkpoints WHERE workspace = ? ORDER BY created_at DESC LIMIT 50').all(this.workspace);

    return (rows as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      sessionId: r.session_id as string,
      workspace: r.workspace as string,
      kind: r.kind as Checkpoint['kind'],
      files: JSON.parse(r.files_json as string),
      metadata: r.metadata_json ? JSON.parse(r.metadata_json as string) : undefined,
      createdAt: r.created_at as number,
    }));
  }

  cleanup(maxAgeMs = 7 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    const result = this.db.raw
      .prepare('DELETE FROM checkpoints WHERE created_at < ?')
      .run(cutoff);
    return result.changes;
  }
}
