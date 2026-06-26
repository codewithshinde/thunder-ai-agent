const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{10,}/g,
  /Bearer\s+[a-zA-Z0-9._-]+/gi,
  /api[_-]?key["\s:=]+["']?[a-zA-Z0-9._-]{8,}/gi,
  /token["\s:=]+["']?[a-zA-Z0-9._-]{8,}/gi,
  /password["\s:=]+["']?[^\s"']{4,}/gi,
];

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

function redactSecrets(value: string): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

function sanitizeMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) {
    return undefined;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes('key') ||
      lowerKey.includes('token') ||
      lowerKey.includes('secret') ||
      lowerKey.includes('password') ||
      lowerKey.includes('authorization')
    ) {
      sanitized[key] = '[REDACTED]';
      continue;
    }
    if (typeof value === 'string') {
      sanitized[key] = redactSecrets(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export function createLogger(scope: string): Logger {
  const prefix = `[Thunder:${scope}]`;

  function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    const safeMessage = redactSecrets(message);
    const safeMeta = sanitizeMeta(meta);
    const line = safeMeta ? `${prefix} ${safeMessage} ${JSON.stringify(safeMeta)}` : `${prefix} ${safeMessage}`;

    switch (level) {
      case 'info':
        console.log(line);
        break;
      case 'warn':
        console.warn(line);
        break;
      case 'error':
        console.error(line);
        break;
    }
  }

  return {
    info: (message, meta) => log('info', message, meta),
    warn: (message, meta) => log('warn', message, meta),
    error: (message, meta) => log('error', message, meta),
  };
}
