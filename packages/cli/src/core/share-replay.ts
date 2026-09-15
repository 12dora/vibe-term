// 分享日志分页与 TTY 回放：解码与 FE `replay-decode` / `use-replay-log` 对齐。

import type { ShareLogEntry, ShareLogKind, ShareLogPage } from '@vibeterm/shared/share';
import { InterruptError, UsageError, throwIfAborted } from './errors';
import type { HttpClient } from './http';
import { sharePath } from './share-target';

export const SGR_RESET = '\x1b[0m';
export const SGR_RESET_BYTES = new TextEncoder().encode(SGR_RESET);

export interface ShareLogQuery {
  after?: number;
  limit?: number;
}

export interface ShareLogFetchOptions extends ShareLogQuery {
  all?: boolean;
}

export interface ShareLogFetch {
  entries: ShareLogEntry[];
  truncated: boolean;
  total: number;
  nextAfter: number | null;
}

export interface ShareReplayPaneJson {
  paneId: string;
  cols: number;
  rows: number;
  chunks: string[];
}

export interface ShareReplayJson {
  panes: ShareReplayPaneJson[];
  durationMs: number;
  entries: number;
}

export interface ShareReplayTtySize {
  cols: number;
  rows: number;
}

export interface ShareReplayPlayOptions {
  paneId?: string;
  speed: number;
  fromMs: number;
  write: (bytes: Uint8Array) => void;
  note: (text: string) => void;
  sleep: (ms: number) => Promise<void>;
  ttySize?: ShareReplayTtySize | null;
  signal?: AbortSignal;
}

/** 与 FE `decodeBase64` 相同：空串 → 空数组，其余走 `atob` 按字节还原。 */
export function decodeShareLogData(data: string): Uint8Array {
  if (data === '') return new Uint8Array(0);
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** 与 FE `base64ByteLength` 相同：不算 padding 之外的解码。 */
export function shareLogDataSize(data: string): number {
  if (data.length === 0) return 0;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

export function formatShareLogLine(entry: ShareLogEntry): string {
  return `${entry.at} ${entry.paneId} ${entry.kind} ${shareLogDataSize(entry.data)}`;
}

export function shareLogQueryPath(id: string, query: ShareLogQuery = {}): string {
  const params = new URLSearchParams();
  if (query.after !== undefined) params.set('after', String(query.after));
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const suffix = params.toString();
  return `${sharePath(id, '/log')}${suffix ? `?${suffix}` : ''}`;
}

export async function fetchShareLogPages(
  http: Pick<HttpClient, 'json'>,
  nodeId: string,
  shareId: string,
  options: ShareLogFetchOptions = {}
): Promise<ShareLogFetch> {
  const entries: ShareLogEntry[] = [];
  let after = options.after;
  let truncated = false;
  let total = 0;
  let nextAfter: number | null = null;
  for (;;) {
    const page = await http.json<ShareLogPage>(
      nodeId,
      'GET',
      shareLogQueryPath(shareId, { after, limit: options.limit })
    );
    truncated = page.truncated;
    total = page.total;
    entries.push(...page.entries);
    nextAfter = page.nextAfter;
    if (!shouldFetchNextPage(options.all === true, page, after)) break;
    after = nextAfter ?? undefined;
  }
  return { entries, truncated, total, nextAfter };
}

function shouldFetchNextPage(all: boolean, page: ShareLogPage, after: number | undefined): boolean {
  if (!all) return false;
  if (page.nextAfter === null || page.entries.length === 0) return false;
  if (after !== undefined && page.nextAfter <= after) return false;
  return true;
}

export function listShareReplayPanes(entries: readonly ShareLogEntry[]): string[] {
  const panes: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.paneId)) continue;
    seen.add(entry.paneId);
    panes.push(entry.paneId);
  }
  return panes;
}

export function pickShareReplayPane(
  entries: readonly ShareLogEntry[],
  paneId: string | undefined
): string | null {
  const panes = listShareReplayPanes(entries);
  if (paneId !== undefined) {
    if (!panes.includes(paneId)) {
      throw new UsageError(
        `unknown pane: ${paneId}`,
        panes.length > 0 ? `panes: ${panes.join(', ')}` : 'this recording has no panes'
      );
    }
    return paneId;
  }
  return panes[0] ?? null;
}

function logSpan(entries: readonly ShareLogEntry[]): { startAt: number; durationMs: number } {
  if (entries.length === 0) return { startAt: 0, durationMs: 0 };
  let startAt = entries[0].at;
  let endAt = entries[0].at;
  for (const entry of entries) {
    if (entry.at < startAt) startAt = entry.at;
    if (entry.at > endAt) endAt = entry.at;
  }
  return { startAt, durationMs: Math.max(0, endAt - startAt) };
}

function isOutputKind(kind: ShareLogKind): boolean {
  return kind === 'out' || kind === 'checkpoint';
}

function entryGrid(entry: ShareLogEntry): ShareReplayTtySize | null {
  if (entry.cols === undefined || entry.rows === undefined) return null;
  return { cols: entry.cols, rows: entry.rows };
}

function decodeChunkText(data: string): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(decodeShareLogData(data));
}

export function assembleShareReplay(
  entries: readonly ShareLogEntry[],
  fromMs = 0
): ShareReplayJson {
  const { startAt, durationMs } = logSpan(entries);
  const floor = startAt + Math.max(0, fromMs);
  const panes = new Map<string, ShareReplayPaneJson>();
  for (const entry of entries) {
    const pane = panes.get(entry.paneId) ?? {
      paneId: entry.paneId,
      cols: 0,
      rows: 0,
      chunks: [],
    };
    const grid = entryGrid(entry);
    if (grid) {
      pane.cols = grid.cols;
      pane.rows = grid.rows;
    }
    if (entry.at >= floor && isOutputKind(entry.kind) && entry.data !== '') {
      pane.chunks.push(decodeChunkText(entry.data));
    }
    panes.set(entry.paneId, pane);
  }
  return { panes: [...panes.values()], durationMs, entries: entries.length };
}

function maybeNoteResize(
  entry: ShareLogEntry,
  ttySize: ShareReplayTtySize | null | undefined,
  note: (text: string) => void
): void {
  if (entry.kind !== 'resize') return;
  const grid = entryGrid(entry);
  if (!grid || !ttySize) return;
  if (grid.cols === ttySize.cols && grid.rows === ttySize.rows) return;
  note(`pane was ${grid.cols}x${grid.rows}`);
}

async function waitUntil(
  at: number,
  clock: number,
  options: ShareReplayPlayOptions
): Promise<void> {
  if (options.speed <= 0) return;
  const wait = (at - clock) / options.speed;
  if (wait <= 0) return;
  throwIfAborted(options.signal);
  await options.sleep(wait);
  throwIfAborted(options.signal);
}

function restoreSgr(write: (bytes: Uint8Array) => void): void {
  write(SGR_RESET_BYTES);
}

export async function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new InterruptError());
    }
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      reject(new InterruptError());
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function installReplayAbort(): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  process.on('SIGINT', onAbort);
  process.on('SIGTERM', onAbort);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off('SIGINT', onAbort);
      process.off('SIGTERM', onAbort);
    },
  };
}

export async function playShareReplay(
  entries: readonly ShareLogEntry[],
  options: ShareReplayPlayOptions
): Promise<void> {
  const paneId = pickShareReplayPane(entries, options.paneId);
  if (paneId === null) return;
  const { startAt } = logSpan(entries);
  const clock0 = startAt + Math.max(0, options.fromMs);
  let clock = clock0;
  try {
    for (const entry of entries) {
      throwIfAborted(options.signal);
      if (entry.paneId !== paneId || entry.at < clock0) continue;
      await waitUntil(entry.at, clock, options);
      clock = entry.at;
      maybeNoteResize(entry, options.ttySize, options.note);
      if (!isOutputKind(entry.kind) || entry.data === '') continue;
      options.write(decodeShareLogData(entry.data));
    }
  } catch (error) {
    restoreSgr(options.write);
    if (error instanceof InterruptError) throw error;
    throwIfAborted(options.signal);
    throw error;
  }
  if (options.signal?.aborted) {
    restoreSgr(options.write);
    throw new InterruptError();
  }
}
