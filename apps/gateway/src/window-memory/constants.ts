export const MIB_BYTES = 1_048_576;
export const HOST_SHELL_TIMEOUT_MS = 10_000;
export const HOST_SHELL_MAX_OUTPUT_BYTES = 256 * 1024;
export const APPLY_RETRY_MS = 60_000;
/** 释放失败的退避上限（60s 起、每次翻倍，到这里停）。 */
export const RELEASE_BACKOFF_MAX_MS = 30 * 60 * 1000;
/** 孤儿清扫最快间隔。设置变更会立刻再扫一次。 */
export const ORPHAN_SWEEP_INTERVAL_MS = 60_000;
/** cgroup / systemd 把限额抬到页边界时，差一页仍算同一档。 */
export const APPLIED_BYTES_TOLERANCE = 4096;
export const HEARTBEAT_MS = 30_000;
export const TICK_DEBOUNCE_MS = 300;
export const STOP_SCOPE_TIMEOUT_MS = 10_000;
export const SAMPLE_INTERVAL_MIN_SEC = 2;
export const SAMPLE_INTERVAL_MAX_SEC = 60;
