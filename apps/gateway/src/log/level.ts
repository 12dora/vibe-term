export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

export function parseLogLevel(raw: string | undefined): LogLevel {
  const value = raw?.trim().toLowerCase();
  if (value === 'error' || value === 'warn' || value === 'info' || value === 'debug') {
    return value;
  }
  return DEFAULT_LOG_LEVEL;
}

export function getLogLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  return parseLogLevel(env.TMEX_LOG_LEVEL);
}

export function shouldLog(level: LogLevel, configured: LogLevel = getLogLevel()): boolean {
  return RANK[level] <= RANK[configured];
}

export function logAt(level: LogLevel, message: string): void {
  if (!shouldLog(level)) return;
  if (level === 'error') {
    console.error(message);
    return;
  }
  if (level === 'warn') {
    console.warn(message);
    return;
  }
  console.log(message);
}
