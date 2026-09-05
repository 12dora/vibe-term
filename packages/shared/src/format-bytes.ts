// 字节量 / 速率的展示格式化。传输进度、中继指标、配额三处共用同一套换算，
// 免得同一个数在不同面板里摆成不同位数。

/**
 * 字节量。先收到两位小数再分档：速率是差分算出来的浮点，
 * 不收就会在 1 KB 以下直接摆出 `237.51937984496124 B`。
 * 非有限值与负数按 0 计——差分跨采样重启时可能为负。
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  const rounded = Math.round(n * 100) / 100;
  if (rounded < 1024) return `${rounded} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = rounded / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[i]}`;
}

export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

/** 「已传 / 总量」一行。两个数走同一套分档，读起来才能比。 */
export function formatBytesPair(used: number, total: number): string {
  return `${formatBytes(used)} / ${formatBytes(total)}`;
}
