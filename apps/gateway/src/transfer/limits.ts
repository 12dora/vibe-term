// 传输的资源预算。源侧限制排队/在跑的任务数，目标侧限制单会话的文件数、总字节、并发写与会话数：
// `/api/mesh-internal/*` 只证明「对端是本用户的某台节点」，一台被攻陷的节点不该能把目标磁盘写满。

const GIB = 1024 * 1024 * 1024;

/** 会话空闲多久回收；有字节在动或有进行中的操作都会续期。 */
export const SESSION_IDLE_MS = 10 * 60_000;
/** 单次 PUT 的体积上限，同时也是进度粒度。 */
export const TRANSFER_CHUNK_BYTES = 8 * 1024 * 1024;
const MIN_CHUNK_BYTES = 64 * 1024;

/** 会话下发给源侧的分片大小；`VIBETERM_TRANSFER_CHUNK_BYTES` 可覆盖（下限 64 KiB）。 */
export function transferChunkBytes(): number {
  const configured = envNumber('VIBETERM_TRANSFER_CHUNK_BYTES');
  if (configured === null) return TRANSFER_CHUNK_BYTES;
  return Math.max(MIN_CHUNK_BYTES, configured);
}

/** 单会话最多登记的文件数，与源侧展开上限同量级。 */
export const MAX_SESSION_FILES = 5000;
/** 单会话同时在写的区间数：并行流最多 4 条，留出重试重叠的余量。 */
export const MAX_SESSION_ACTIVE_WRITES = 16;
/** 同一源节点同时持有的会话数。 */
export const MAX_SESSIONS_PER_PEER = 4;
/** 本节点同时持有的会话总数。 */
export const MAX_SESSIONS_TOTAL = 32;

/** 单用户排队 + 在跑的任务数。 */
export const MAX_JOBS_PER_USER = 8;
/** 全节点排队 + 在跑的任务数。 */
export const MAX_JOBS_TOTAL = 32;
/** 已完成任务的保留条数上限（超过按完成时间淘汰最旧的）。 */
export const MAX_FINISHED_JOBS = 200;

const DEFAULT_SESSION_MAX_BYTES = 64 * GIB;

function envNumber(key: string): number | null {
  const raw = process.env[key];
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * 单会话累计可写字节。默认 64 GiB，`VIBETERM_TRANSFER_SESSION_MAX_BYTES` 可覆盖；
 * 与单文件上限取大，保证一个合法的大文件永远塞得进一个会话。
 */
export function sessionMaxBytes(perFileLimit: number): number {
  const configured = envNumber('VIBETERM_TRANSFER_SESSION_MAX_BYTES') ?? DEFAULT_SESSION_MAX_BYTES;
  return Math.max(configured, perFileLimit);
}
