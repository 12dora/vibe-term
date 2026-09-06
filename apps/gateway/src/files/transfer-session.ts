// 上传/下载会话状态：分块传输期间在内存维护 session + 本机临时文件。
// 字节落盘交给 `@vibeterm/transfer/node` 的 `ResumableSink`（乱序区间 + 位图 + rename 落位），
// 这里只管会话生命周期。清理三重保障：显式清理 + 周期 GC + 启动孤儿扫描。
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResumableSink, type SinkDescriptor } from '@vibeterm/transfer/node';

const sink = new ResumableSink();

export interface UploadSession {
  id: string;
  rootId: string;
  destDir: string;
  /** 已消毒的目标文件名 */
  name: string;
  /** 声明的总字节数 */
  size: number;
  /** 已落盘字节数（乱序写入时为已收区间的总长度） */
  received: number;
  /** 已收满并 rename 到 tmpPath */
  complete: boolean;
  tmpDir: string;
  /** 收满后的本机完整文件，commit 阶段推给设备 */
  tmpPath: string;
  descriptor: SinkDescriptor;
  /** commit 阶段把 signal 传给 rsync；cancel 时 abort 以中止推送 */
  abort: AbortController;
  createdAt: number;
  committing: boolean;
  /** 并行区间同时写满时只允许落位一次 */
  commitOnce: Promise<{ ok: boolean }> | null;
}

const sessions = new Map<string, UploadSession>();
const SESSION_TTL_MS = 30 * 60_000;

// 下载会话：prepare 阶段把设备上的文件准备成本机可读文件后登记，供 content 阶段区间读取。
export interface DownloadSession {
  id: string;
  tmpPath: string;
  size: number;
  name: string;
  mime: string | null;
  cleanup: () => void;
  createdAt: number;
  /** 建会话那一刻源文件的 mtime；本机设备的下载直接读原文件，续传前要确认它没被改过 */
  sourceMtimeMs: number | null;
}
const downloads = new Map<string, DownloadSession>();

function sweepStale(now: number): void {
  for (const [id, s] of sessions) {
    if (!s.committing && now - s.createdAt > SESSION_TTL_MS) {
      removeUploadSession(id);
    }
  }
  for (const [id, d] of downloads) {
    if (now - d.createdAt > SESSION_TTL_MS) {
      removeDownloadSession(id);
    }
  }
}

export function createDownloadSession(
  data: Omit<DownloadSession, 'id' | 'createdAt' | 'sourceMtimeMs'>
): DownloadSession {
  sweepStale(Date.now());
  const session: DownloadSession = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    sourceMtimeMs: fileMtimeMs(data.tmpPath),
    ...data,
  };
  downloads.set(session.id, session);
  return session;
}

function fileMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 续传前的源文件校验。本机设备的下载不再复制一份到 tmpdir，读的就是用户的原文件——
 * 中途被改写的话，接着拉只会拼出一份半新半旧的内容，必须干脆地失败。
 */
export function downloadSourceChanged(session: DownloadSession): boolean {
  let stat: { size: number; mtimeMs: number };
  try {
    stat = statSync(session.tmpPath);
  } catch {
    return true;
  }
  if (stat.size !== session.size) return true;
  return session.sourceMtimeMs !== null && stat.mtimeMs !== session.sourceMtimeMs;
}

export function getDownloadSession(id: string): DownloadSession | undefined {
  return downloads.get(id);
}

// 移除下载会话并删除其临时文件。
export function removeDownloadSession(id: string): void {
  const d = downloads.get(id);
  if (!d) return;
  downloads.delete(id);
  try {
    d.cleanup();
  } catch {
    // best-effort
  }
}

export function createUploadSession(args: {
  rootId: string;
  destDir: string;
  name: string;
  size: number;
}): UploadSession {
  const now = Date.now();
  sweepStale(now);
  const tmpDir = mkdtempSync(join(tmpdir(), 'vibeterm-up-'));
  const tmpPath = join(tmpDir, 'f');
  const id = crypto.randomUUID();
  const session: UploadSession = {
    id,
    rootId: args.rootId,
    destDir: args.destDir,
    name: args.name,
    size: args.size,
    received: 0,
    complete: args.size === 0,
    tmpDir,
    tmpPath,
    descriptor: {
      destPath: tmpPath,
      key: id,
      mode: 'ranged',
      totalBytes: args.size,
      maxBytes: args.size,
    },
    abort: new AbortController(),
    createdAt: now,
    committing: false,
    commitOnce: null,
  };
  // 零字节文件没有任何区间可写，直接把目标文件建出来，commit 时就能照常推送。
  if (args.size === 0) writeFileSync(tmpPath, new Uint8Array(0));
  sessions.set(id, session);
  return session;
}

export function getUploadSession(id: string): UploadSession | undefined {
  return sessions.get(id);
}

/** 已收区间（升序不重叠），供客户端断线后只补发缺口。 */
export async function uploadRanges(id: string): Promise<Array<[number, number]>> {
  const session = sessions.get(id);
  if (!session) return [];
  if (session.complete) return session.size > 0 ? [[0, session.size]] : [];
  const state = await sink.status(session.descriptor);
  return state.ranges.map((r) => [r.offset, r.length]);
}

export type UploadWriteFailure =
  | 'not_found'
  | 'bad_offset'
  | 'too_large'
  | 'cancelled'
  | 'incomplete'
  | 'conflict'
  | 'unknown';

export type UploadWriteResult =
  | { ok: true; received: number; complete: boolean }
  | { ok: false; reason: UploadWriteFailure };

const FAILURE_MAP: Record<string, UploadWriteFailure> = {
  offset_mismatch: 'bad_offset',
  too_large: 'too_large',
  incomplete: 'incomplete',
  checksum_mismatch: 'unknown',
  aborted: 'cancelled',
  invalid: 'unknown',
  io_error: 'unknown',
  conflict: 'conflict',
  sealed: 'conflict',
};

/**
 * 写入一段区间。允许乱序、允许并行——收满后自动 rename 成 `tmpPath`。
 * `contentLength` 用于判定链路中断（收到的比声明的少）与提前拒绝越界区间；
 * `maxWriteBytes` 是本次 PUT 的硬上限，与客户端声明无关。
 */
export async function writeUploadRange(
  id: string,
  input: {
    offset: number;
    contentLength?: number;
    maxWriteBytes?: number;
    body: ReadableStream<Uint8Array>;
  }
): Promise<UploadWriteResult> {
  const session = sessions.get(id);
  if (!session) return { ok: false, reason: 'not_found' };
  if (input.offset < 0 || input.offset > session.size) return { ok: false, reason: 'too_large' };
  const written = await sink.write(session.descriptor, input.body, {
    offset: input.offset,
    contentLength: input.contentLength,
    maxWriteBytes: input.maxWriteBytes,
    signal: session.abort.signal,
  });
  if (sessions.get(id) !== session) return { ok: false, reason: 'cancelled' };
  if (!written.ok) return failedWrite(session, written);
  session.received = Math.max(session.received, written.receivedBytes);
  if (written.complete && !session.complete) {
    // 并行写入时可能有多条流同时看到「收满」，落位只做一次
    session.commitOnce ??= sink.commit(session.descriptor);
    const committed = await session.commitOnce;
    if (!committed.ok) return { ok: false, reason: 'unknown' };
    if (sessions.get(id) !== session) return { ok: false, reason: 'cancelled' };
    session.complete = true;
  }
  return { ok: true, received: session.received, complete: session.complete };
}

/** 已经落位封存的会话再收到迟到的重复区间：内容早就齐了，如实回「已完成」即可。 */
function failedWrite(
  session: UploadSession,
  written: Extract<Awaited<ReturnType<typeof sink.write>>, { ok: false }>
): UploadWriteResult {
  if (written.code === 'sealed' && session.complete) {
    return { ok: true, received: session.received, complete: true };
  }
  if (written.code === 'incomplete') {
    session.received = Math.max(session.received, written.receivedBytes);
  }
  return { ok: false, reason: FAILURE_MAP[written.code] ?? 'unknown' };
}

/** 字节版便捷入口（RTC bulk 直连按顺序送帧时用）。 */
export function writeUploadBytes(
  id: string,
  offset: number,
  bytes: Uint8Array
): Promise<UploadWriteResult> {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
  return writeUploadRange(id, {
    offset,
    contentLength: bytes.byteLength,
    maxWriteBytes: bytes.byteLength,
    body,
  });
}

// 移除会话：中止进行中的 rsync 推送 + 删除临时文件。
export function removeUploadSession(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try {
    s.abort.abort();
  } catch {
    // 已中止
  }
  try {
    rmSync(s.tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// 周期性兜底 GC：即使后续没有新上传，也清理被遗弃的会话（如客户端中途关闭页面、未发 DELETE）。
// unref 使其不阻塞进程/测试退出。
const transferGcTimer = setInterval(() => sweepStale(Date.now()), 5 * 60_000);
transferGcTimer.unref?.();

// 传输临时目录前缀（上传会话 / 下载拉取 / 节点间接收暂存），用于启动孤儿扫描
// 新前缀 + tmex 时期的旧前缀：升级后残留的旧临时目录同样要被清掉
const ORPHAN_PREFIXES = [
  'vibeterm-up-',
  'vibeterm-dl-',
  'vibeterm-rx-',
  'tmex-up-',
  'tmex-dl-',
  'tmex-rx-',
];
const ORPHAN_MAX_AGE_MS = 60 * 60_000; // 仅清理 >1h 的，确保不会误删进行中传输（即便多实例）

// 启动时扫描 tmpdir，清理上次崩溃/异常退出残留的传输临时目录。由 gateway 启动时调用一次。
export function sweepOrphanTransferTemps(): void {
  const base = tmpdir();
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!ORPHAN_PREFIXES.some((p) => name.startsWith(p))) continue;
    const full = join(base, name);
    try {
      if (now - statSync(full).mtimeMs > ORPHAN_MAX_AGE_MS) {
        rmSync(full, { recursive: true, force: true });
      }
    } catch {
      // best-effort
    }
  }
}
