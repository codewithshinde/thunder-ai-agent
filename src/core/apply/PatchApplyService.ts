import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createPatch, applyPatch as applyDiffPatch } from 'diff';
import { hashContent } from '../indexing/hash';
import { createLogger } from '../telemetry/Logger';
import { validateMdxContent } from './mdxValidation';

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

    const granularity = this.validatePatchGranularity(patch.path, patch.oldText, patch.newText);
    if (!granularity.success) {
      return granularity;
    }

    if (patch.oldText && !current.includes(patch.oldText)) {
      const fuzzy = findFuzzyReplacement(current, patch.oldText);
      if (fuzzy) {
        const proposed = current.replace(fuzzy.matched, patch.newText);
        return { success: true, proposedContent: proposed };
      }
      const hint = buildOldTextHint(current, patch.oldText);
      return {
        success: false,
        error: hint
          ? `oldText not found in file. ${hint}`
          : 'oldText not found in file — read_file the target first and copy exact text including whitespace.',
      };
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

    const syntaxCheck = this.validateSyntax(patch.path, validation.proposedContent);
    if (!syntaxCheck.success) {
      return syntaxCheck;
    }

    try {
      writeFileSync(join(this.workspace, patch.path), validation.proposedContent, 'utf-8');
      log.info('Patch applied', { path: patch.path });
      return { success: true, proposedContent: validation.proposedContent };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  /** Plandex-style validate-and-fix: basic syntax guards before apply. */
  validateSyntax(path: string, content: string): PatchResult {
    const mdxValidationError = validateMdxContent(path, content);
    if (mdxValidationError) {
      return { success: false, error: mdxValidationError };
    }

    if (path.endsWith('.json')) {
      try {
        JSON.parse(content);
      } catch (e) {
        return { success: false, error: `Invalid JSON after patch: ${String(e)}` };
      }
    }

    const balances = countCodeDelimiters(content);
    const jsxBalance = path.endsWith('.tsx') ? countJsxTagBalance(content) : 0;

    if (
      balances.openBraces !== balances.closeBraces ||
      balances.openParens !== balances.closeParens ||
      Math.abs(jsxBalance) > 12
    ) {
      return {
        success: false,
        error: 'Bracket/tag imbalance detected — patch may be incomplete. Patch a complete logical block and retry.',
      };
    }

    return { success: true, proposedContent: content };
  }

  private validatePatchGranularity(path: string, oldText: string, newText: string): PatchResult {
    if (!/\.[jt]sx$/.test(path) || oldText === '') {
      return { success: true };
    }

    const oldLines = oldText.trim().split(/\r?\n/).filter(Boolean);
    const newLines = newText.trim().split(/\r?\n/).filter(Boolean);
    const touchesJsx = /<[A-Za-z][^>]*>|<\/[A-Za-z][^>]*>/.test(`${oldText}\n${newText}`);
    const isImportOnly = oldLines.every((line) => /^\s*import\b/.test(line)) && newLines.every((line) => /^\s*import\b/.test(line));

    if (!isImportOnly && touchesJsx && (oldLines.length < 3 || newLines.length < 3)) {
      return {
        success: false,
        error: 'Unsafe TSX patch rejected: replace the complete JSX/component block, not an isolated line or partial snippet.',
      };
    }

    return { success: true };
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

function countCodeDelimiters(content: string): {
  openBraces: number;
  closeBraces: number;
  openParens: number;
  closeParens: number;
} {
  let openBraces = 0;
  let closeBraces = 0;
  let openParens = 0;
  let closeParens = 0;
  let quote: '"' | "'" | '`' | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    const next = content[i + 1];

    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }

    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      lineComment = true;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }

    if (ch === '{') openBraces += 1;
    if (ch === '}') closeBraces += 1;
    if (ch === '(') openParens += 1;
    if (ch === ')') closeParens += 1;
  }

  return { openBraces, closeBraces, openParens, closeParens };
}

function countJsxTagBalance(content: string): number {
  let balance = 0;

  for (let i = 0; i < content.length; i += 1) {
    if (content[i] !== '<') continue;

    const next = content[i + 1];
    const isClosing = next === '/';
    const nameStart = isClosing ? i + 2 : i + 1;
    const firstNameChar = content[nameStart];
    if (!firstNameChar || !/[A-Z]/.test(firstNameChar)) continue;

    const tagEnd = findJsxTagEnd(content, nameStart + 1);
    if (tagEnd === -1) {
      balance += isClosing ? -1 : 1;
      continue;
    }

    if (isClosing) {
      balance -= 1;
    } else if (!isSelfClosingTag(content, tagEnd)) {
      balance += 1;
    }

    i = tagEnd;
  }

  return balance;
}

function findJsxTagEnd(content: string, start: number): number {
  let quote: '"' | "'" | '`' | undefined;
  let escaped = false;
  let braceDepth = 0;

  for (let i = start; i < content.length; i += 1) {
    const ch = content[i];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }

    if (ch === '{') {
      braceDepth += 1;
      continue;
    }

    if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }

    if (ch === '>' && braceDepth === 0) {
      return i;
    }
  }

  return -1;
}

function isSelfClosingTag(content: string, tagEnd: number): boolean {
  for (let i = tagEnd - 1; i >= 0; i -= 1) {
    const ch = content[i];
    if (/\s/.test(ch)) continue;
    return ch === '/';
  }
  return false;
}

/** Try line-trimmed contiguous block match when exact oldText is missing. */
function findFuzzyReplacement(
  current: string,
  oldText: string
): { matched: string } | null {
  if (!oldText.trim()) return null;
  if (current.includes(oldText)) return { matched: oldText };

  const normalizedOld = normalizePatchText(oldText);
  const lines = current.split(/\r?\n/);
  const oldLines = oldText.split(/\r?\n/);
  const window = oldLines.length;
  if (window < 1) return null;

  for (let i = 0; i <= lines.length - window; i += 1) {
    const slice = lines.slice(i, i + window).join('\n');
    if (normalizePatchText(slice) === normalizedOld) {
      return { matched: slice };
    }
  }
  return null;
}

function normalizePatchText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, '  ')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/[ \u00a0]+/g, ' ')
    .trim();
}

function buildOldTextHint(current: string, oldText: string): string | undefined {
  const probe = oldText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 2);
  if (probe.length === 0) return undefined;
  const idx = current.indexOf(probe[0]!);
  if (idx < 0) return undefined;
  const lineNo = current.slice(0, idx).split(/\r?\n/).length;
  return `Near line ${lineNo} the file contains similar text — re-read the file and patch the exact block.`;
}
