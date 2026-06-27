import type { SessionLogService } from './SessionLogService';

/**
 * Lightweight span tracker for session processes.
 * Always logs `process_end` with durationMs when a SessionLogService is attached.
 */
export class SessionTiming {
  private readonly starts = new Map<string, number>();

  start(process: string): void {
    this.starts.set(process, Date.now());
  }

  /** Ends a span and logs duration. Returns durationMs, or 0 if the span was missing. */
  end(process: string, log?: SessionLogService, data?: Record<string, unknown>): number {
    const startedAt = this.starts.get(process);
    if (startedAt === undefined) return 0;
    this.starts.delete(process);

    const durationMs = Date.now() - startedAt;
    log?.appendTiming(process, durationMs, data);
    return durationMs;
  }

  async track<T>(
    process: string,
    log: SessionLogService | undefined,
    fn: () => Promise<T>,
    data?: Record<string, unknown>
  ): Promise<T> {
    this.start(process);
    try {
      return await fn();
    } finally {
      this.end(process, log, data);
    }
  }
}
