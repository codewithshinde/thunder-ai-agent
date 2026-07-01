import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Logger', () => {
  it('should exist as a module', async () => {
    const { createLogger } = await import('../src/core/telemetry/Logger');
    const log = createLogger('test');
    expect(log.info).toBeDefined();
    expect(log.warn).toBeDefined();
    expect(log.error).toBeDefined();
  });
});

describe('SessionLogService', () => {
  it('keeps numeric token usage while redacting string secrets', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'thunder-log-test-'));
    try {
      const { SessionLogService } = await import('../src/core/telemetry/SessionLogService');
      const log = new SessionLogService();
      log.configure(workspace, 'session-1', true);
      log.append('token_usage', 'usage', {
        promptTokens: 123,
        apiToken: 'secret-token-value',
      });
      const contents = readFileSync(log.getLogPath(), 'utf-8');
      expect(contents).toContain('"promptTokens":123');
      expect(contents).toContain('"apiToken":"[REDACTED]"');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('ThunderSession', () => {
  it('creates session with defaults', async () => {
    const { ThunderSession } = await import('../src/core/session/ThunderSession');
    const session = new ThunderSession('/workspace');
    expect(session.id).toBeTruthy();
    expect(session.workspace).toBe('/workspace');
    expect(session.mode).toBe('plan');
  });
});

describe('Error normalization', () => {
  it('normalizes Error objects', async () => {
    const { normalizeError } = await import('../src/core/telemetry/errors');
    const result = normalizeError(new Error('test error'));
    expect(result.message).toBe('test error');
  });
});
