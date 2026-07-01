import { randomUUID } from 'crypto';
import type { ThunderDb } from '../indexing/ThunderDb';
import type { ThunderSession } from './ThunderSession';
import type { ChatMessage } from '../llm/types';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('SessionService');

export class SessionService {
  constructor(private readonly db: ThunderDb) {}

  ensureSession(session: ThunderSession, title?: string): void {
    const db = this.db.tryRaw();
    if (!db) return;

    const existing = db
      .prepare('SELECT id FROM agent_sessions WHERE id = ?')
      .get(session.id) as { id: string } | undefined;

    if (existing) {
      db
        .prepare('UPDATE agent_sessions SET mode = ?, updated_at = ? WHERE id = ?')
        .run(session.mode, Date.now(), session.id);
      return;
    }

    db.prepare(`
      INSERT INTO agent_sessions (id, workspace, title, mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.workspace,
      title ?? null,
      session.mode,
      session.createdAt,
      session.updatedAt
    );
    log.info('Session persisted', { sessionId: session.id });
  }

  updateTitle(sessionId: string, title: string): void {
    const db = this.db.tryRaw();
    if (!db) return;
    db
      .prepare('UPDATE agent_sessions SET title = ?, updated_at = ? WHERE id = ?')
      .run(title.slice(0, 200), Date.now(), sessionId);
  }

  saveTurn(sessionId: string, role: string, content: string): void {
    const db = this.db.tryRaw();
    if (!db) return;
    db.prepare(`
      INSERT INTO agent_turns (id, session_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), sessionId, role, content, Date.now());

    db
      .prepare('UPDATE agent_sessions SET updated_at = ? WHERE id = ?')
      .run(Date.now(), sessionId);
  }

  loadTurns(sessionId: string, limit = 20): ChatMessage[] {
    const db = this.db.tryRaw();
    if (!db) return [];
    const rows = db
      .prepare(`
        SELECT role, content FROM agent_turns
        WHERE session_id = ?
        ORDER BY created_at ASC
        LIMIT ?
      `)
      .all(sessionId, limit) as Array<{ role: string; content: string }>;

    return rows
      .filter((r) => r.role === 'user' || r.role === 'assistant')
      .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }));
  }

  saveSessionSummary(sessionId: string, summary: string): void {
    const db = this.db.tryRaw();
    if (!db) return;
    db.prepare(`
      INSERT INTO session_summaries (id, session_id, summary, created_at)
      VALUES (?, ?, ?, ?)
    `).run(randomUUID(), sessionId, summary, Date.now());
  }
}
