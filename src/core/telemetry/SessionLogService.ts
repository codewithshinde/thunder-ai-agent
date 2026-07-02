import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { AGENT_NAME } from '../../shared/brand';
import { createLogger } from './Logger';

const log = createLogger('SessionLogService');

export type SessionLogEventType =
  | 'session_start'
  | 'session_end'
  | 'user_message'
  | 'assistant_message'
  | 'tool_start'
  | 'tool_end'
  | 'subagent_start'
  | 'subagent_end'
  | 'approval_request'
  | 'approval_decision'
  | 'plan_created'
  | 'plan_step'
  | 'context_pack'
  | 'token_usage'
  | 'process_start'
  | 'process_end'
  | 'timing'
  | 'error'
  | 'info'
  | 'workspace_resolved'
  | 'index_start'
  | 'index_complete'
  | 'turn_complete'
  | 'ui_trace'
  | 'microtask_context'
  | 'audit_export';

export interface SessionLogEvent {
  ts: number;
  time: string;
  sessionId: string;
  type: SessionLogEventType;
  /** Human-readable summary for quick scanning */
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Append-only JSONL session log for debugging and post-hoc analysis.
 * Files: `<workspace>/.mitii/logs/<local-time>-<sessionId>.jsonl`
 */
export class SessionLogService {
  private enabled = true;
  private debugMetrics = false;
  private workspace = '';
  private sessionId = '';
  private logPath = '';
  private logStartedAt = 0;

  configure(workspace: string, sessionId: string, enabled = true, debugMetrics = false): void {
    const sessionChanged = this.sessionId !== sessionId;
    this.workspace = workspace;
    this.sessionId = sessionId;
    this.enabled = enabled && Boolean(workspace);
    this.debugMetrics = debugMetrics;
    if (!this.enabled) return;
    if (sessionChanged || !this.logStartedAt) {
      this.logStartedAt = Date.now();
      this.logPath = '';
    }

    const dir = join(workspace, '.mitii', 'logs');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (!this.logPath) {
      this.logPath = join(dir, `${formatTimestampForFile(this.logStartedAt)}-${sessionId}.jsonl`);
    }
  }

  isEnabled(): boolean {
    return this.enabled && Boolean(this.logPath);
  }

  isDebugMetricsEnabled(): boolean {
    return this.debugMetrics;
  }

  getLogPath(): string {
    return this.logPath;
  }

  append(type: SessionLogEventType, message: string, data?: Record<string, unknown>): void {
    if (!this.isEnabled()) return;
    this.writeEvent(type, message, data);
  }

  /** Verbose diagnostics — only written when `telemetry.debugMetrics` is enabled. */
  appendDebug(type: SessionLogEventType, message: string, data?: Record<string, unknown>): void {
    if (!this.isEnabled() || !this.debugMetrics) return;
    this.writeEvent(type, message, data);
  }

  /** UI and internal traces — only when debugMetrics is enabled. */
  appendUiTrace(message: string, data?: Record<string, unknown>): void {
    if (!this.isEnabled() || !this.debugMetrics) return;
    this.writeEvent('ui_trace', message, data);
  }

  /** Record how long a named process took. Always logged when session logging is on. */
  appendTiming(process: string, durationMs: number, data?: Record<string, unknown>): void {
    if (!this.isEnabled()) return;
    this.writeEvent('timing', process, {
      durationMs,
      durationSec: Math.round(durationMs / 100) / 10,
      ...data,
    });
  }

  private writeEvent(type: SessionLogEventType, message: string, data?: Record<string, unknown>): void {
    const ts = Date.now();
    const event: SessionLogEvent = {
      ts,
      time: formatTimestampForLog(ts),
      sessionId: this.sessionId,
      type,
      message,
      data: sanitizeLogData(data),
    };

    try {
      appendFileSync(this.logPath, `${JSON.stringify(event)}\n`, 'utf-8');
    } catch (error) {
      log.warn('Failed to append session log', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Write a session header once at start (idempotent). */
  writeSessionHeader(meta: Record<string, unknown>): void {
    if (!this.isEnabled() || !this.logPath) return;
    if (existsSync(this.logPath) && readFileSync(this.logPath, 'utf-8').trim().length > 0) {
      return;
    }

    const header = {
      _format: 'mitii-session-log',
      version: 1,
      sessionId: this.sessionId,
      workspace: this.workspace,
      startedAt: this.logStartedAt || Date.now(),
      startedAtLocal: formatTimestampForLog(this.logStartedAt || Date.now()),
      ...meta,
    };

    try {
      const ts = Date.now();
      writeFileSync(this.logPath, `${JSON.stringify({
        ts,
        time: formatTimestampForLog(ts),
        sessionId: this.sessionId,
        type: 'session_start',
        message: 'Session started',
        data: header,
      })}\n`, 'utf-8');
    } catch (error) {
      log.warn('Failed to write session log header', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  exportForAnalysis(): string {
    if (!this.logPath || !existsSync(this.logPath)) {
      return '';
    }
    return readFileSync(this.logPath, 'utf-8');
  }

  exportSummary(): string {
    if (!this.logPath || !existsSync(this.logPath)) {
      return 'No session log found.';
    }

    const lines = readFileSync(this.logPath, 'utf-8').trim().split('\n').filter(Boolean);
    const counts: Record<string, number> = {};
    const errors: string[] = [];
    const timings: Array<{ process: string; durationMs: number; durationSec?: number }> = [];
    let firstTs = 0;
    let lastTs = 0;

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as SessionLogEvent;
        counts[event.type] = (counts[event.type] ?? 0) + 1;
        if (!firstTs || event.ts < firstTs) firstTs = event.ts;
        if (event.ts > lastTs) lastTs = event.ts;
        if (event.type === 'error') {
          errors.push(event.message);
        }
        if (event.type === 'timing' && typeof event.data?.durationMs === 'number') {
          timings.push({
            process: event.message,
            durationMs: event.data.durationMs,
            durationSec: typeof event.data.durationSec === 'number' ? event.data.durationSec : undefined,
          });
        }
      } catch {
        // skip malformed lines
      }
    }

    const durationSec = firstTs && lastTs ? Math.round((lastTs - firstTs) / 1000) : 0;
    const countLines = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `  ${k}: ${v}`)
      .join('\n');

    const timingLines = timings
      .sort((a, b) => b.durationMs - a.durationMs)
      .map((t) => {
        const sec = t.durationSec ?? Math.round(t.durationMs / 100) / 10;
        return `  ${t.process}: ${sec}s (${t.durationMs}ms)`;
      })
      .join('\n');

    const totalTimedMs = timings.reduce((sum, t) => sum + t.durationMs, 0);
    const toolLines = lines
      .map((line) => {
        try {
          const event = JSON.parse(line) as SessionLogEvent;
          if (event.type !== 'tool_end') return undefined;
          const data = event.data ?? {};
          const name = String(data.toolName ?? data.tool ?? event.message);
          const id = typeof data.toolCallId === 'string' ? `#${data.toolCallId}` : '';
          const locator = typeof data.path === 'string'
            ? ` path=${data.path}`
            : typeof data.command === 'string'
              ? ` command=${data.command}`
              : '';
          const status = data.success === false ? 'failed' : 'ok';
          const duration = typeof data.durationMs === 'number' ? `${data.durationMs}ms` : 'n/a';
          const preview = typeof data.outputPreview === 'string' && data.outputPreview
            ? ` — ${data.outputPreview.replace(/\s+/g, ' ').slice(0, 120)}`
            : '';
          return `  ${name}${id}${locator}: ${status}, ${duration}${preview}`;
        } catch {
          return undefined;
        }
      })
      .filter((line): line is string => Boolean(line));

    return [
      `# ${AGENT_NAME} session log summary`,
      `session: ${this.sessionId}`,
      `workspace: ${this.workspace}`,
      `log file: ${this.logPath}`,
      `started: ${firstTs ? formatTimestampForLog(firstTs) : '(unknown)'}`,
      `ended: ${lastTs ? formatTimestampForLog(lastTs) : '(unknown)'}`,
      `duration: ${durationSec}s`,
      `events: ${lines.length}`,
      '',
      '## Event counts',
      countLines || '  (none)',
      '',
      timings.length > 0
        ? `## Process timing (${Math.round(totalTimedMs / 100) / 10}s tracked)\n${timingLines}`
        : '## Process timing\n  (none — enable session logging and retry)',
      '',
      toolLines.length > 0
        ? `## Tool calls (${toolLines.length})\n${toolLines.join('\n')}`
        : '## Tool calls\n  (none)',
      '',
      errors.length > 0 ? `## Errors (${errors.length})\n${errors.map((e) => `- ${e}`).join('\n')}` : '## Errors\n  (none)',
      '',
      '## Full log',
      'Attach the .jsonl file or paste its contents for analysis.',
    ].join('\n');
  }
}

function formatTimestampForFile(ts: number): string {
  const d = new Date(ts);
  return [
    d.getFullYear(),
    pad2(d.getMonth() + 1),
    pad2(d.getDate()),
  ].join('-') + '_' + [
    pad2(d.getHours()),
    pad2(d.getMinutes()),
    pad2(d.getSeconds()),
  ].join('-');
}

function formatTimestampForLog(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function sanitizeLogData(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return undefined;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (shouldRedactKey(key)) {
      out[key] = typeof value === 'string' ? '[REDACTED]' : value;
      continue;
    }
    if (typeof value === 'string' && value.length > 8000) {
      out[key] = `${value.slice(0, 8000)}… [truncated ${value.length - 8000} chars]`;
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) => sanitizeValue(item));
    } else if (value && typeof value === 'object') {
      out[key] = sanitizeValue(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' && value.length > 8000
      ? `${value.slice(0, 8000)}… [truncated ${value.length - 8000} chars]`
      : value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (shouldRedactKey(key)) {
      out[key] = typeof nestedValue === 'string' ? '[REDACTED]' : nestedValue;
    } else {
      out[key] = sanitizeValue(nestedValue);
    }
  }
  return out;
}

/** Redact secrets but preserve token usage metrics (promptTokens, sessionTotal, etc.). */
function shouldRedactKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (
    lower.endsWith('tokens') ||
    lower.includes('tokenusage') ||
    lower.includes('token_count') ||
    lower === 'sessiontotal' ||
    lower === 'turncount'
  ) {
    return false;
  }
  return (
    lower.includes('apikey') ||
    lower.includes('api_key') ||
    lower === 'authorization' ||
    lower.includes('secret') ||
    lower.includes('password') ||
    (lower.includes('key') && !lower.includes('monkey') && !lower.includes('token')) ||
    (lower.includes('token') &&
      (lower.includes('secret') ||
        lower.includes('api') ||
        lower.endsWith('key') ||
        lower === 'token' ||
        lower === 'accesstoken' ||
        lower === 'refreshtoken'))
  );
}
