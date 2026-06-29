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
  | 'ui_trace';

export interface SessionLogEvent {
  ts: number;
  sessionId: string;
  type: SessionLogEventType;
  /** Human-readable summary for quick scanning */
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Append-only JSONL session log for debugging and post-hoc analysis.
 * Files: `<workspace>/.thunder/logs/<sessionId>.jsonl`
 */
export class SessionLogService {
  private enabled = true;
  private debugMetrics = false;
  private workspace = '';
  private sessionId = '';
  private logPath = '';

  configure(workspace: string, sessionId: string, enabled = true, debugMetrics = false): void {
    this.workspace = workspace;
    this.sessionId = sessionId;
    this.enabled = enabled && Boolean(workspace);
    this.debugMetrics = debugMetrics;
    if (!this.enabled) return;

    const dir = join(workspace, '.thunder', 'logs');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.logPath = join(dir, `${sessionId}.jsonl`);
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
    const event: SessionLogEvent = {
      ts: Date.now(),
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
      _format: 'thunder-session-log',
      version: 1,
      sessionId: this.sessionId,
      workspace: this.workspace,
      startedAt: Date.now(),
      ...meta,
    };

    try {
      writeFileSync(this.logPath, `${JSON.stringify({ ts: Date.now(), sessionId: this.sessionId, type: 'session_start', message: 'Session started', data: header })}\n`, 'utf-8');
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

    return [
      `# ${AGENT_NAME} session log summary`,
      `session: ${this.sessionId}`,
      `workspace: ${this.workspace}`,
      `log file: ${this.logPath}`,
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
      errors.length > 0 ? `## Errors (${errors.length})\n${errors.map((e) => `- ${e}`).join('\n')}` : '## Errors\n  (none)',
      '',
      '## Full log',
      'Attach the .jsonl file or paste its contents for analysis.',
    ].join('\n');
  }
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
    } else {
      out[key] = value;
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
