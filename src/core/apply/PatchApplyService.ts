import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createPatch, applyPatch as applyDiffPatch } from 'diff';
import { hashContent } from '../indexing/hash';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('PatchApplyService');

export interface StructuredPatch {
  path: string;
  oldText: string;
  newText: string;
  expectedHash?: string;
}

export interface PatchResult {
  success: boolean;
  error?: string;
  proposedContent?: string;
}

export class PatchApplyService {
  constructor(private readonly workspace: string) {}

  validate(patch: StructuredPatch): PatchResult {
    const fullPath = join(this.workspace, patch.path);
    let current: string;
    try {
      current = readFileSync(fullPath, 'utf-8');
    } catch {
      if (patch.oldText === '') {
        return { success: true, proposedContent: patch.newText };
      }
      return { success: false, error: 'File not found' };
    }

    if (patch.expectedHash && hashContent(current) !== patch.expectedHash) {
      return { success: false, error: 'File hash mismatch — file may have changed' };
    }

    if (patch.oldText && !current.includes(patch.oldText)) {
      return { success: false, error: 'oldText not found in file' };
    }

    const proposed = patch.oldText
      ? current.replace(patch.oldText, patch.newText)
      : patch.newText;

    return { success: true, proposedContent: proposed };
  }

  apply(patch: StructuredPatch): PatchResult {
    const validation = this.validate(patch);
    if (!validation.success || !validation.proposedContent) {
      return validation;
    }

    try {
      writeFileSync(join(this.workspace, patch.path), validation.proposedContent, 'utf-8');
      log.info('Patch applied', { path: patch.path });
      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  createUnifiedDiff(path: string, oldContent: string, newContent: string): string {
    return createPatch(path, oldContent, newContent);
  }

  applyUnifiedDiff(path: string, diff: string): PatchResult {
    const fullPath = join(this.workspace, path);
    let current: string;
    try {
      current = readFileSync(fullPath, 'utf-8');
    } catch {
      return { success: false, error: 'File not found' };
    }

    const result = applyDiffPatch(current, diff);
    if (!result) {
      return { success: false, error: 'Failed to apply unified diff' };
    }
    return { success: true, proposedContent: result };
  }
}
