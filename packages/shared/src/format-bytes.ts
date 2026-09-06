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

/** 从 KB 起档的单位表。速率与表格里的字节量都不摆 `B`：单字符单位会让列宽在边界上跳。 */
const SCALED_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

export type ScaledByteUnit = (typeof SCALED_UNITS)[number];

export interface FormattedRate {
  /** 完整读数，如 `12.3 MB/s`。等于 `${value} ${unit}/s`。 */
  text: string;
  /** 只有数字部分，固定一位小数，如 `12.3`。 */
  value: string;
  /** 字节量级单位，不含 `/s`。 */
  unit: ScaledByteUnit;
}

/**
 * 从 KB 起档换算。进位判断按「收成一位小数之后」的值来做，
 * 否则 1048570 字节会摆成 `1024.0 KB` 而不是 `1.0 MB`。
 * 非有限值与负数按 0 计——速率是差分算出来的，跨采样重启时可能为负。
 */
function scaleFromKb(bytes: number): { value: number; unit: ScaledByteUnit } {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  let value = safe / 1024;
  let index = 0;
  while (index < SCALED_UNITS.length - 1 && Math.round(value * 10) / 10 >= 1024) {
    value /= 1024;
    index += 1;
  }
  return { value, unit: SCALED_UNITS[index] };
}

/**
 * 速率。固定一位小数、固定两字符单位、最低一档是 `0.0 KB/s`——
 * 位数与单位长度都不随数值变，列宽才不会跟着刷新抖。
 */
export function formatRateParts(bytesPerSec: number): FormattedRate {
  const { value, unit } = scaleFromKb(bytesPerSec);
  const text = value.toFixed(1);
  return { text: `${text} ${unit}/s`, value: text, unit };
}

export function formatRate(bytesPerSec: number): string {
  return formatRateParts(bytesPerSec).text;
}

/**
 * 表格 / 实时计数器用的字节量：与 `formatRate` 同一套定档，宽度稳定。
 * 文件大小仍走 `formatBytes`（`200 MB` 这种零位小数是有意的）。
 */
export function formatBytesFixed(n: number): string {
  const { value, unit } = scaleFromKb(n);
  return `${value.toFixed(1)} ${unit}`;
}

/** 「已传 / 总量」一行。传输进度每几百毫秒刷一次，两个数都走宽度稳定的那一档。 */
export function formatBytesPair(used: number, total: number): string {
  return `${formatBytesFixed(used)} / ${formatBytesFixed(total)}`;
}

/**
 * 剩余时间。`h:mm:ss`（不足一小时为 `m:ss`），无法估算时为 `--`。
 * 超过 99 小时按 `99:59:59` 封顶——比展示一个五位数小时更可读。
 */
export function formatEta(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '--';
  const total = Math.min(Math.round(seconds), 99 * 3600 + 3599);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
