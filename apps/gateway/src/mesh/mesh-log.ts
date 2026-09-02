const STAMPED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

export function isoNow(date = new Date()): string {
  return date.toISOString();
}

export function formatLogLine(tag: string, msg: string, now = new Date()): string {
  const body = msg ? `${tag} ${msg}` : tag;
  return `${isoNow(now)} ${body}`;
}

export function stamp(line: string, now = new Date()): string {
  if (STAMPED_RE.test(line)) return line;
  return `${isoNow(now)} ${line}`;
}

export function logLine(tag: string, msg = '', now = new Date()): void {
  console.log(formatLogLine(tag, msg, now));
}

export function warnLine(tag: string, msg = '', now = new Date()): void {
  console.warn(formatLogLine(tag, msg, now));
}

export function infoLine(tag: string, msg = '', now = new Date()): void {
  console.info(formatLogLine(tag, msg, now));
}

export function envInt(name: string, fallback: number, min = 0): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}
