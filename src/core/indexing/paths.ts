import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';

export function resolveThunderDir(workspacePath: string): string {
  return join(workspacePath, '.thunder');
}

export function resolveDbPath(workspacePath: string): string {
  return join(resolveThunderDir(workspacePath), 'thunder.sqlite');
}

export function ensureThunderDir(workspacePath: string): string {
  const dir = resolveThunderDir(workspacePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function resolveCheckpointDir(workspacePath: string, checkpointId: string): string {
  return join(resolveThunderDir(workspacePath), 'checkpoints', checkpointId);
}
