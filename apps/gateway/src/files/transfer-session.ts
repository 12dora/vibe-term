// 上传会话状态：分块上传期间在内存维护 session + 本机临时文件。
// 纯状态管理（不含 rsync）。清理三重保障：每次操作的显式清理 + 周期 GC + 启动孤儿扫描。
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface UploadSession {
  id: string;
  rootId: string;
  destDir: string;
  /** 已消毒的目标文件名 */
  name: string;
  /** 声明的总字节数 */
  size: number;
  /** 已落盘字节数 */
  received: number;
  tmpDir: string;
  tmpPath: string;
  /** commit 阶段把 signal 传给 rsync；cancel 时 abort 以中止推送 */
  abort: AbortController;
  createdAt: number;
  committing: boolean;
}

const sessions = new Map<string, UploadSession>();
const SESSION_TTL_MS = 30 * 60_000;

// 下载会话：prepare 阶段 rsync 拉到本机临时文件后登记，供 content 阶段流式读取。
export interface DownloadSession {
  id: string;
  tmpPath: string;
  size: number;
  name: string;
  mime: string | null;
  cleanup: () => void;
  createdAt: number;
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
  data: Omit<DownloadSession, 'id' | 'createdAt'>
): DownloadSession {
  sweepStale(Date.now());
  const session: DownloadSession = { id: crypto.randomUUID(), createdAt: Date.now(), ...data };
  downloads.set(session.id, session);
  return session;
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
  const tmpDir = mkdtempSync(join(tmpdir(), 'tmex-up-'));
  const tmpPath = join(tmpDir, 'f');
  writeFileSync(tmpPath, new Uint8Array(0));
  const session: UploadSession = {
    id: crypto.randomUUID(),
    rootId: args.rootId,
    destDir: args.destDir,
    name: args.name,
    size: args.size,
    received: 0,
    tmpDir,
    tmpPath,
    abort: new AbortController(),
    createdAt: now,
    committing: false,
  };
  sessions.set(session.id, session);
  return session;
}

export function getUploadSession(id: string): UploadSession | undefined {
  return sessions.get(id);
}

export type AppendResult =
  | { ok: true; received: number }
  | { ok: false; reason: 'not_found' | 'bad_offset' | 'too_large' | 'cancelled' };

type AppendFail = Exclude<AppendResult, { ok: true }>;

function prepareAppend(
  id: string,
  offset: number,
  byteLength: number
): { ok: true; session: UploadSession } | AppendFail {
  const s = sessions.get(id);
  if (!s) return { ok: false, reason: 'not_found' };
  if (offset !== s.received) return { ok: false, reason: 'bad_offset' };
  if (s.received + byteLength > s.size) return { ok: false, reason: 'too_large' };
  return { ok: true, session: s };
}

function advanceReceived(session: UploadSession, byteLength: number): AppendResult {
  session.received += byteLength;
  return { ok: true, received: session.received };
}

const sessionTails = new Map<string, Promise<void>>();

function enqueueSessionOp<T>(id: string, op: () => Promise<T>): Promise<T> {
  const prev = sessionTails.get(id) ?? Promise.resolve();
  const next = prev.then(op, op);
  const settled = next.then(
    () => undefined,
    () => undefined
  );
  sessionTails.set(id, settled);
  void settled.then(() => {
    if (sessionTails.get(id) === settled && !sessions.has(id)) sessionTails.delete(id);
  });
  return next;
}

async function persistChunk(tmpPath: string, committed: number, bytes: Uint8Array): Promise<void> {
  const fh = await fsPromises.open(tmpPath, 'a');
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await fh.write(bytes.subarray(offset));
      if (bytesWritten <= 0) throw new Error('short write');
      offset += bytesWritten;
    }
    await fh.close();
  } catch (err) {
    try {
      await fh.truncate(committed);
    } catch {
      try {
        truncateSync(tmpPath, committed);
      } catch {
        // 临时文件可能已被 cancel 删掉
      }
    }
    try {
      await fh.close();
    } catch {
      // 可能已关闭
    }
    throw err;
  }
}

// 顺序追加 chunk：offset 必须等于已收字节数；不得超出声明 size。
export function appendUploadChunk(id: string, offset: number, bytes: Uint8Array): AppendResult {
  const prepared = prepareAppend(id, offset, bytes.byteLength);
  if (!prepared.ok) return prepared;
  appendFileSync(prepared.session.tmpPath, bytes);
  return advanceReceived(prepared.session, bytes.byteLength);
}

async function appendUploadChunkLocked(
  id: string,
  offset: number,
  bytes: Uint8Array
): Promise<AppendResult> {
  const prepared = prepareAppend(id, offset, bytes.byteLength);
  if (!prepared.ok) return prepared;
  const session = prepared.session;
  const committed = session.received;
  try {
    await persistChunk(session.tmpPath, committed, bytes);
  } catch (err) {
    if (sessions.get(id) !== session) return { ok: false, reason: 'cancelled' };
    throw err;
  }
  if (sessions.get(id) !== session) {
    try {
      truncateSync(session.tmpPath, committed);
    } catch {
      // 已 cancel 并删除
    }
    return { ok: false, reason: 'cancelled' };
  }
  return advanceReceived(session, bytes.byteLength);
}

export function appendUploadChunkAsync(
  id: string,
  offset: number,
  bytes: Uint8Array
): Promise<AppendResult> {
  return enqueueSessionOp(id, () => appendUploadChunkLocked(id, offset, bytes));
}

// 移除会话：中止进行中的 rsync 推送 + 删除临时文件。
export function removeUploadSession(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  sessionTails.delete(id);
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

// 传输临时目录前缀（上传会话 / 下载拉取），用于启动孤儿扫描
const ORPHAN_PREFIXES = ['tmex-up-', 'tmex-dl-'];
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
