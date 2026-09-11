// woff2/sfnt 的 cmap 读取与 unicode-range 推导。
// 默认终端字体拆成「latin 子集 + 余下字形」两个 @font-face，两者的 unicode-range 必须
// 严格互补且只覆盖字体真正有的码位：范围写宽了，浏览器会为一个根本没有字形的字符
// 去下载 1.16 MB 的完整文件；写窄了则该字符落回系统等宽，排版错位。
// 因此范围一律从产物 cmap 反推，不手写。

import * as wawoff2 from 'wawoff2';

export type CodepointRange = readonly [number, number];

const WOFF2_SIGNATURE = 0x774f4632; // 'wOF2'

/** woff2 解回 sfnt；已是 sfnt 时原样返回 */
export async function toSfnt(font: Uint8Array): Promise<Uint8Array> {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  if (view.getUint32(0) === WOFF2_SIGNATURE) {
    return new Uint8Array(await wawoff2.decompress(font));
  }
  return font;
}

function findTable(sfnt: Uint8Array, view: DataView, tag: string): number | null {
  const numTables = view.getUint16(4);
  for (let i = 0; i < numTables; i += 1) {
    const record = 12 + i * 16;
    const found = String.fromCharCode(
      sfnt[record] as number,
      sfnt[record + 1] as number,
      sfnt[record + 2] as number,
      sfnt[record + 3] as number
    );
    if (found === tag) return view.getUint32(record + 8);
  }
  return null;
}

function readFormat4(view: DataView, sub: number, out: Set<number>): void {
  const segCountX2 = view.getUint16(sub + 6);
  const endOffset = sub + 14;
  const startOffset = endOffset + segCountX2 + 2;
  for (let seg = 0; seg < segCountX2 / 2; seg += 1) {
    const end = view.getUint16(endOffset + seg * 2);
    const start = view.getUint16(startOffset + seg * 2);
    if (start === 0xffff) continue;
    for (let cp = start; cp <= end; cp += 1) out.add(cp);
  }
}

function readFormat12(view: DataView, sub: number, out: Set<number>): void {
  const groups = view.getUint32(sub + 12);
  for (let g = 0; g < groups; g += 1) {
    const offset = sub + 16 + g * 12;
    const start = view.getUint32(offset);
    const end = view.getUint32(offset + 4);
    for (let cp = start; cp <= end; cp += 1) out.add(cp);
  }
}

/** 读出 sfnt 的 cmap 覆盖码位（只认 format 4 / 12，现代字体够用） */
export function readCoveredCodepoints(sfnt: Uint8Array): Set<number> {
  const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const cmap = findTable(sfnt, view, 'cmap');
  if (cmap === null) throw new Error('字体缺少 cmap 表');

  const covered = new Set<number>();
  const subtables = view.getUint16(cmap + 2);
  for (let i = 0; i < subtables; i += 1) {
    const sub = cmap + view.getUint32(cmap + 4 + i * 8 + 4);
    const format = view.getUint16(sub);
    if (format === 4) readFormat4(view, sub, covered);
    else if (format === 12) readFormat12(view, sub, covered);
  }
  return covered;
}

export function toRanges(codepoints: Iterable<number>): CodepointRange[] {
  const sorted = [...codepoints].sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const cp of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && cp === last[1] + 1) last[1] = cp;
    else ranges.push([cp, cp]);
  }
  return ranges;
}

const hex = (cp: number) => cp.toString(16).toUpperCase().padStart(4, '0');

/** 序列化成 CSS `unicode-range` 的值 */
export function formatUnicodeRange(ranges: readonly CodepointRange[]): string {
  return ranges
    .map(([start, end]) => (start === end ? `U+${hex(start)}` : `U+${hex(start)}-${hex(end)}`))
    .join(',');
}

/** 把码位范围展开成用于驱动 hb-subset 的文本（代理区跳过） */
export function rangesToText(ranges: readonly CodepointRange[]): string {
  const chars: string[] = [];
  for (const [start, end] of ranges) {
    for (let cp = start; cp <= end; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      chars.push(String.fromCodePoint(cp));
    }
  }
  return chars.join('');
}
