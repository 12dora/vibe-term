export const EXEC_CHUNK_BYTES = 64 * 1024;
export const EXEC_STREAM_CAP_BYTES = 8 * 1024 * 1024;
export const EXEC_MIN_MAX_BYTES = 1024;
export const EXEC_DEFAULT_TIMEOUT_MS = 600_000;
export const EXEC_MAX_TIMEOUT_MS = 3_600_000;
export const EXEC_KILL_GRACE_MS = 5_000;
/** 子进程存活期间 NDJSON 心跳间隔；重置 Bun.serve / fetch 空闲时钟。 */
export const EXEC_KEEPALIVE_MS = 10_000;
