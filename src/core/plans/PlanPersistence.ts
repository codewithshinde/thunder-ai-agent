import { randomUUID } from 'crypto';
import type { ThunderDb } from '../indexing/ThunderDb';
import type { ThunderPlan } from './PlanActEngine';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('PlanPersistence');

export class PlanPersistence {
  constructor(private readonly db: ThunderDb) {}

  save(sessionId: string, plan: ThunderPlan, status = 'active'): string {
    const db = this.db.tryRaw();
    if (!db) return randomUUID();

    const existing = this.getActive(sessionId);
    const id = existing?.id ?? randomUUID();
    const now = Date.now();

    if (existing) {
      db.prepare(`
        UPDATE task_plans SET goal = ?, status = ?, plan_json = ?, updated_at = ?
        WHERE id = ?
      `).run(plan.goal, status, JSON.stringify(plan), now, id);
    } else {
      db.prepare(`
        INSERT INTO task_plans (id, session_id, goal, status, plan_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, sessionId, plan.goal, status, JSON.stringify(plan), now, now);
    }

    log.info('Plan saved', { id, steps: plan.steps.length });
    return id;
  }

  updatePlan(sessionId: string, plan: ThunderPlan, status?: string): void {
    const db = this.db.tryRaw();
    if (!db) return;

    const active = this.getActive(sessionId);
    if (!active) {
      this.save(sessionId, plan, status ?? 'active');
      return;
    }
    db.prepare(`
      UPDATE task_plans SET plan_json = ?, status = COALESCE(?, status), updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(plan), status ?? null, Date.now(), active.id);
  }

  getActive(sessionId: string): { id: string; plan: ThunderPlan; status: string } | null {
    const db = this.db.tryRaw();
    if (!db) return null;

    const row = db
      .prepare(`
        SELECT id, plan_json, status FROM task_plans
        WHERE session_id = ? AND status IN ('active', 'running')
        ORDER BY updated_at DESC LIMIT 1
      `)
      .get(sessionId) as { id: string; plan_json: string; status: string } | undefined;

    if (!row) return null;
    return { id: row.id, plan: JSON.parse(row.plan_json) as ThunderPlan, status: row.status };
  }

  complete(sessionId: string): void {
    const db = this.db.tryRaw();
    if (!db) return;
    db
      .prepare(`UPDATE task_plans SET status = 'completed', updated_at = ? WHERE session_id = ? AND status IN ('active', 'running')`)
      .run(Date.now(), sessionId);
  }
}
