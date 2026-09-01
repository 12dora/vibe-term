import { open } from 'node:fs/promises';
import type { TunnelConnectorStatus } from '@tmex/shared';
import { redactSecrets } from './redact';

export const EMPTY_CONNECTOR: TunnelConnectorStatus = {
  reachable: null,
  metricsAddr: null,
  readyConnections: null,
  connectorId: null,
  checkedAt: null,
  lastError: null,
};

export const DEFAULT_METRICS_ADDRS = [
  '127.0.0.1:20241',
  '127.0.0.1:20242',
  '127.0.0.1:20243',
  '127.0.0.1:20244',
  '127.0.0.1:20245',
] as const;

const METRICS_SERVER_RE = /metrics server on ([^\s"']+)/i;
const TEXT_ERR_RE = /(?:^|\s)ERR\s+(.*)$/;

export type ConnectorFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function normalizeMetricsAddr(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let addr = raw.trim();
  if (!addr) return null;
  addr = addr.replace(/^https?:\/\//i, '');
  addr = addr.replace(/\/metrics\/?$/i, '');
  addr = addr.replace(/\/+$/, '');
  return addr || null;
}

export function parseMetricsAddrFromLog(lines: readonly string[]): string | null {
  let found: string | null = null;
  for (const line of lines) {
    const match = METRICS_SERVER_RE.exec(line);
    if (!match?.[1]) continue;
    const addr = normalizeMetricsAddr(match[1]);
    if (addr) found = addr;
  }
  return found;
}

export function discoverMetricsAddr(opts: {
  spawnedAddr?: string | null;
  argvAddr?: string | null;
  logLines?: readonly string[];
  includeDefaults?: boolean;
}): string[] {
  const spawned = normalizeMetricsAddr(opts.spawnedAddr);
  if (spawned) return [spawned];
  const argv = normalizeMetricsAddr(opts.argvAddr);
  if (argv) return [argv];
  const fromLog = parseMetricsAddrFromLog(opts.logLines ?? []);
  if (fromLog) return [fromLog];
  if (opts.includeDefaults === false) return [];
  return [...DEFAULT_METRICS_ADDRS];
}

function wrapHostPort(addr: string): string {
  if (addr.startsWith('[')) return addr;
  const lastColon = addr.lastIndexOf(':');
  if (lastColon <= 0) return addr;
  const host = addr.slice(0, lastColon);
  if (host.includes(':')) return `[${host}]:${addr.slice(lastColon + 1)}`;
  return addr;
}

export function metricsReadyUrl(addr: string): string {
  const normalized = normalizeMetricsAddr(addr) ?? addr;
  return `http://${wrapHostPort(normalized)}/ready`;
}

function isoNow(now?: () => number): string {
  return new Date(now ? now() : Date.now()).toISOString();
}

function connectorResult(
  partial: Partial<TunnelConnectorStatus> &
    Pick<TunnelConnectorStatus, 'reachable' | 'metricsAddr'>,
  now?: () => number
): TunnelConnectorStatus {
  return {
    reachable: partial.reachable,
    metricsAddr: partial.metricsAddr,
    readyConnections: partial.readyConnections ?? null,
    connectorId: partial.connectorId ?? null,
    checkedAt: partial.checkedAt ?? isoNow(now),
    lastError: partial.lastError ?? null,
  };
}

type ReadyBody = {
  readyConnections?: unknown;
  connectorId?: unknown;
};

function parseReadyBody(
  text: string
): { readyConnections: number; connectorId: string | null } | null {
  try {
    const parsed = JSON.parse(text) as ReadyBody;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.readyConnections !== 'number' || !Number.isFinite(parsed.readyConnections)) {
      return null;
    }
    return {
      readyConnections: parsed.readyConnections,
      connectorId: typeof parsed.connectorId === 'string' ? parsed.connectorId : null,
    };
  } catch {
    return null;
  }
}

async function probeOne(
  addr: string,
  fetchImpl: ConnectorFetch,
  timeoutMs: number
): Promise<TunnelConnectorStatus | 'no-answer'> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(metricsReadyUrl(addr), { signal: ac.signal });
    if (res.status !== 200 && res.status !== 503) return 'no-answer';
    const body = parseReadyBody(await res.text());
    if (!body) return 'no-answer';
    return connectorResult({
      reachable: true,
      metricsAddr: addr,
      readyConnections: body.readyConnections,
      connectorId: body.connectorId,
    });
  } catch {
    return 'no-answer';
  } finally {
    clearTimeout(timer);
  }
}

export async function probeConnector(
  addr: string | readonly string[] | null | undefined,
  fetchImpl: ConnectorFetch,
  opts?: { timeoutMs?: number; now?: () => number }
): Promise<TunnelConnectorStatus> {
  const timeoutMs = opts?.timeoutMs ?? 1_500;
  const list = Array.isArray(addr) ? [...addr] : addr ? [addr] : [];
  const normalized = list
    .map((item) => normalizeMetricsAddr(item))
    .filter((item): item is string => Boolean(item));
  const scanning = normalized.length > 1;

  if (normalized.length === 0) {
    return connectorResult({ reachable: null, metricsAddr: null }, opts?.now);
  }

  for (const candidate of normalized) {
    const result = await probeOne(candidate, fetchImpl, timeoutMs);
    if (result !== 'no-answer') return { ...result, checkedAt: isoNow(opts?.now) };
    if (!scanning) {
      return connectorResult({ reachable: false, metricsAddr: candidate }, opts?.now);
    }
  }
  return connectorResult({ reachable: null, metricsAddr: null }, opts?.now);
}

function tryParseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function jsonErrorText(rec: Record<string, unknown>): string | null {
  const level = rec.level;
  if (typeof level !== 'string' || level.toLowerCase() !== 'error') return null;
  if (typeof rec.error === 'string' && rec.error.trim()) return rec.error;
  if (typeof rec.message === 'string' && rec.message.trim()) return rec.message;
  return null;
}

function textErrorText(line: string): string | null {
  const match = TEXT_ERR_RE.exec(line);
  return match?.[1]?.trim() ? match[1].trim() : null;
}

export function extractLastError(lines: readonly string[]): string | null {
  let found: string | null = null;
  for (const line of lines) {
    const rec = tryParseJsonLine(line);
    const text = rec ? jsonErrorText(rec) : textErrorText(line);
    if (text) found = redactSecrets(text);
  }
  return found;
}

export async function readLogTail(
  path: string,
  opts?: { maxBytes?: number; maxLines?: number }
): Promise<string[]> {
  const maxBytes = opts?.maxBytes ?? 64 * 1024;
  const maxLines = opts?.maxLines ?? 200;
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(path, 'r');
    const stat = await fh.stat();
    const size = stat.size;
    if (size <= 0) return [];
    const length = Math.min(maxBytes, size);
    const start = size - length;
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, start);
    const text = buf.toString('utf8');
    const parts = text.split(/\r?\n/);
    if (start > 0 && parts.length) parts.shift();
    const lines = parts.filter((line) => line.length > 0).map((line) => redactSecrets(line));
    return lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
  } catch {
    return [];
  } finally {
    await fh?.close().catch(() => {});
  }
}
