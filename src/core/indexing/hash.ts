import { createHash } from 'crypto';
import { readFileSync } from 'fs';

export function hashContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export function hashFile(path: string): string {
  const content = readFileSync(path);
  return hashContent(content);
}
