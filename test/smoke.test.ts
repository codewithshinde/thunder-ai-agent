import { describe, it, expect } from 'vitest';

describe('Logger', () => {
  it('should exist as a module', async () => {
    const { createLogger } = await import('../src/core/telemetry/Logger');
    const log = createLogger('test');
    expect(log.info).toBeDefined();
    expect(log.warn).toBeDefined();
    expect(log.error).toBeDefined();
  });
});

describe('ThunderSession', () => {
  it('creates session with defaults', async () => {
    const { ThunderSession } = await import('../src/core/ThunderSession');
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
