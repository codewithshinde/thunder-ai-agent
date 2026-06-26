import { randomUUID } from 'crypto';
import type { ThunderDb } from '../indexing/ThunderDb';
import type { ThunderSession } from '../ThunderSession';
import type { ChatMessage } from '../llm/types';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('SessionService');

export class SessionService {
  constructor(private readonly db: ThunderDb) {}

  ensureSession(session: ThunderSession, title?: string): void {
    const existing = this.db.raw
      .prepare('SELECT id FROM agent_sessions WHERE id = ?')
      .get(session.id) as { id: string } | undefined;

    if (existing) {
      this.db.raw
        .prepare('UPDATE agent_sessions SET mode = ?, updated_at = ? WHERE id = ?')
        .run(session.mode, Date.now(), session.id);
      return;
    }

    this.db.raw.prepare(`
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
    this.db.raw
      .prepare('UPDATE agent_sessions SET title = ?, updated_at = ? WHERE id = ?')
      .run(title.slice(0, 200), Date.now(), sessionId);
  }

  saveTurn(sessionId: string, role: string, content: string): void {
    this.db.raw.prepare(`
      INSERT INTO agent_turns (id, session_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), sessionId, role, content, Date.now());

    this.db.raw
      .prepare('UPDATE agent_sessions SET updated_at = ? WHERE id = ?')
      .run(Date.now(), sessionId);
  }

  loadTurns(sessionId: string, limit = 20): ChatMessage[] {
    const rows = this.db.raw
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
    this.db.raw.prepare(`
      INSERT INTO session_summaries (id, session_id, summary, created_at)
      VALUES (?, ?, ?, ?)
    `).run(randomUUID(), sessionId, summary, Date.now());
  }
}
