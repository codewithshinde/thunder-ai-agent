import { randomUUID } from 'crypto';

export type ThunderMode = 'plan' | 'act' | 'review';

export interface ThunderSessionState {
  id: string;
  workspace: string;
  mode: ThunderMode;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

export class ThunderSession {
  readonly id: string;
  readonly workspace: string;
  mode: ThunderMode;
  title: string | null;
  readonly createdAt: number;
  updatedAt: number;

  constructor(workspace: string, mode: ThunderMode = 'plan') {
    this.id = randomUUID();
    this.workspace = workspace;
    this.mode = mode;
    this.title = null;
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
  }

  touch(): void {
    this.updatedAt = Date.now();
  }

  setMode(mode: ThunderMode): void {
    this.mode = mode;
    this.touch();
  }

  toState(): ThunderSessionState {
    return {
      id: this.id,
      workspace: this.workspace,
      mode: this.mode,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
