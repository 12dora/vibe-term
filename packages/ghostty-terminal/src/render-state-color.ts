import type { GhosttyColorRgb } from './types';

// 内插表上限：正常终端里 style 组合与实际用色都是几十到几百量级，超出即认为
// 出现了病态输入，整表丢弃重建，避免 Map 无界增长。
export const INTERN_LIMIT = 8192;

// 颜色对象内插：同一 RGB 在整屏里成千上万次出现，按打包整数键复用同一实例，
// 让上层可以用引用相等做「这个 cell 变了吗」的判断。
export function internColor(
  colorCache: Map<number, GhosttyColorRgb>,
  red: number,
  green: number,
  blue: number
): GhosttyColorRgb {
  const key = (red << 16) | (green << 8) | blue;
  return internColorByKey(colorCache, key, red, green, blue);
}

export function internColorByKey(
  colorCache: Map<number, GhosttyColorRgb>,
  key: number,
  red: number,
  green: number,
  blue: number
): GhosttyColorRgb {
  const cached = colorCache.get(key);
  if (cached) {
    return cached;
  }

  if (colorCache.size >= INTERN_LIMIT) {
    colorCache.clear();
  }

  const color: GhosttyColorRgb = { r: red, g: green, b: blue };
  colorCache.set(key, color);
  return color;
}

export function readColorAt(
  colorCache: Map<number, GhosttyColorRgb>,
  ptr: number,
  view: DataView
): GhosttyColorRgb {
  return internColor(
    colorCache,
    view.getUint8(ptr),
    view.getUint8(ptr + 1),
    view.getUint8(ptr + 2)
  );
}
