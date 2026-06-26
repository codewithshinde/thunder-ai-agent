import { randomUUID } from 'crypto';

export type SubagentStatus = 'queued' | 'running' | 'done' | 'error';

export interface SubagentRun {
  id: string;
  task: string;
  focus?: string;
  status: SubagentStatus;
  startedAt: number;
  finishedAt?: number;
  summary?: string;
  error?: string;
}

export type SubagentUpdateCallback = (runs: SubagentRun[]) => void;

export class SubagentTracker {
  private runs: SubagentRun[] = [];
  private onUpdate: SubagentUpdateCallback | undefined;

  setUpdateCallback(cb: SubagentUpdateCallback | undefined): void {
    this.onUpdate = cb;
  }

  clear(): void {
    this.runs = [];
    this.notify();
  }

  start(task: string, focus?: string): string {
    const run: SubagentRun = {
      id: randomUUID(),
      task,
      focus,
      status: 'running',
      startedAt: Date.now(),
    };
    this.runs = [...this.runs, run].slice(-12);
    this.notify();
    return run.id;
  }

  finish(id: string, summary: string): void {
    this.runs = this.runs.map((r) =>
      r.id === id
        ? { ...r, status: 'done' as const, finishedAt: Date.now(), summary: summary.slice(0, 300) }
        : r
    );
    this.notify();
  }

  fail(id: string, error: string): void {
    this.runs = this.runs.map((r) =>
      r.id === id
        ? { ...r, status: 'error' as const, finishedAt: Date.now(), error: error.slice(0, 200) }
        : r
    );
    this.notify();
  }

  getRuns(): SubagentRun[] {
    return [...this.runs];
  }

  private notify(): void {
    this.onUpdate?.(this.getRuns());
  }
}
