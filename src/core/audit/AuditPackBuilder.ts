import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';
import type { ToolCallAudit } from '../tools/types';

export interface AuditPackManifest {
  sessionId: string;
  workspace: string;
  extensionVersion: string;
  model?: string;
  createdAt: string;
  logPath?: string;
  eventCount: number;
}

export interface AuditPackInput {
  sessionId: string;
  workspace: string;
  extensionVersion: string;
  model?: string;
  logPath?: string;
  summaryMarkdown: string;
  toolAudit?: ToolCallAudit[];
  approvals?: unknown[];
  stripFileContents?: boolean;
}

export interface AuditPackBuildResult {
  buffer: Buffer;
  manifest: AuditPackManifest;
  redactionReport: RedactionReport;
  entries: string[];
}

export interface RedactionReport {
  secretKeyRedactions: number;
  longValueTruncations: number;
  fileContentStrips: number;
}

export class AuditPackBuilder {
  build(input: AuditPackInput): AuditPackBuildResult {
    const report: RedactionReport = {
      secretKeyRedactions: 0,
      longValueTruncations: 0,
      fileContentStrips: 0,
    };
    const sessionJsonl = input.logPath && existsSync(input.logPath)
      ? sanitizeJsonl(readFileSync(input.logPath, 'utf8'), report, input.stripFileContents)
      : '';
    const eventCount = sessionJsonl.trim() ? sessionJsonl.trim().split(/\r?\n/).length : 0;
    const manifest: AuditPackManifest = {
      sessionId: input.sessionId,
      workspace: input.workspace,
      extensionVersion: input.extensionVersion,
      model: input.model,
      createdAt: new Date().toISOString(),
      logPath: input.logPath ? basename(input.logPath) : undefined,
      eventCount,
    };
    const files: Record<string, string> = {
      'session.jsonl': sessionJsonl,
      'summary.md': input.summaryMarkdown,
      'manifest.json': JSON.stringify(manifest, null, 2),
      'tool-audit.json': JSON.stringify(sanitizeValue(input.toolAudit ?? [], report, input.stripFileContents), null, 2),
      'approvals.json': JSON.stringify(sanitizeValue(input.approvals ?? [], report, input.stripFileContents), null, 2),
      'redaction-report.json': JSON.stringify(report, null, 2),
    };
    return {
      buffer: createZip(files),
      manifest,
      redactionReport: report,
      entries: Object.keys(files),
    };
  }
}

function sanitizeJsonl(jsonl: string, report: RedactionReport, stripFileContents = false): string {
  return jsonl
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.stringify(sanitizeValue(JSON.parse(line), report, stripFileContents));
      } catch {
        return '[malformed log line omitted]';
      }
    })
    .join('\n') + (jsonl.trim() ? '\n' : '');
}

function sanitizeValue(value: unknown, report: RedactionReport, stripFileContents = false): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, report, stripFileContents));
  if (typeof value === 'string') {
    if (looksLikeSecret(value)) {
      report.secretKeyRedactions += 1;
      return '[REDACTED]';
    }
    if (value.length > 8000) {
      report.longValueTruncations += 1;
      return `${value.slice(0, 8000)}... [truncated ${value.length - 8000} chars]`;
    }
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (shouldRedactKey(key)) {
      report.secretKeyRedactions += 1;
      out[key] = '[REDACTED]';
    } else if (stripFileContents && /^(content|fileContent|output|outputPreview)$/i.test(key) && typeof nested === 'string') {
      report.fileContentStrips += 1;
      out[key] = `[stripped ${nested.length} chars]`;
    } else {
      out[key] = sanitizeValue(nested, report, stripFileContents);
    }
  }
  return out;
}

function shouldRedactKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.includes('apikey') ||
    lower.includes('api_key') ||
    lower === 'authorization' ||
    lower.includes('secret') ||
    lower.includes('password') ||
    lower === 'token' ||
    lower === 'accesstoken' ||
    lower === 'refreshtoken';
}

function looksLikeSecret(value: string): boolean {
  return /\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{20,}|Bearer\s+[A-Za-z0-9._-]{16,})\b/.test(value);
}

function createZip(files: Record<string, string>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'));
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDir, end]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

