// 默认终端字体的 latin 子集分片。
//
// 为什么只对默认字体做：终端首帧要等 document.fonts.load 拿到精确字形度量，
// 而 Geist Mono Nerd Font 两个字重合计 2.3 MB —— 2 Mbps 下这是 9 秒以上的纯等待。
// 拆成「首屏子集（约 45 KB）+ 余下字形」两个 @font-face 后，首帧只等子集，
// Nerd 图标由 font-display:swap 后到，到达后终端重绘一次即可。
//
// 这里刻意用 hb-subset（subset-font）而不是 wawoff2：整份转码要的是「一个字形都不能掉」，
// 而子集要的正好相反——只留可达字形。两者用途不同，不冲突。
//
// 两个面的 unicode-range 由产物 cmap 反推、严格互补：
//   子集面 = 子集字体实际覆盖的码位
//   完整面 = 完整字体覆盖、但子集不覆盖的码位
// 这样既不会让浏览器为一个字体根本没有的字符（如 CJK）去下载 1.16 MB，
// 也不会让子集面吞掉本该由完整文件提供的图标。

import * as fs from 'node:fs';
import * as path from 'node:path';
import subsetFont from 'subset-font';
import {
  type CodepointRange,
  formatUnicodeRange,
  rangesToText,
  readCoveredCodepoints,
  toRanges,
  toSfnt,
} from './font-cmap';

export interface LatinSubsetFace {
  /** 子集产物的 public URL */
  url: string;
  /** 子集产物字节数 */
  bytes: number;
}

export interface LatinSubsetResult {
  regular: LatinSubsetFace;
  bold: LatinSubsetFace;
  /** 子集面的 unicode-range */
  unicodeRange: string;
  /** 完整文件那一面的 unicode-range（与上面互补） */
  fullUnicodeRange: string;
}

/** manifest 里的 URL（`/fonts/x.woff2`）映射到 packages/theme 下的真实文件 */
function resourcePath(fontsRoot: string, url: string): string {
  return path.join(fontsRoot, url.replace(/^\/fonts\//, ''));
}

async function subsetOne(
  fontsRoot: string,
  sourceUrl: string,
  outUrl: string,
  text: string
): Promise<{ face: LatinSubsetFace; covered: Set<number>; fullCovered: Set<number> }> {
  const source = fs.readFileSync(resourcePath(fontsRoot, sourceUrl));
  const subset = await subsetFont(source, text, { targetFormat: 'woff2' });
  const outPath = resourcePath(fontsRoot, outUrl);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, subset);
  return {
    face: { url: outUrl, bytes: subset.length },
    covered: readCoveredCodepoints(await toSfnt(new Uint8Array(subset))),
    fullCovered: readCoveredCodepoints(await toSfnt(new Uint8Array(source))),
  };
}

export async function buildLatinSubset(input: {
  fontsRoot: string;
  full: { regular: string; bold: string };
  subset: { regular: string; bold: string };
  ranges: readonly CodepointRange[];
}): Promise<LatinSubsetResult> {
  const text = rangesToText(input.ranges);
  const regular = await subsetOne(input.fontsRoot, input.full.regular, input.subset.regular, text);
  const bold = await subsetOne(input.fontsRoot, input.full.bold, input.subset.bold, text);

  // 两个字重的 cmap 取并集：任一字重能渲染的码位都该由子集面负责，
  // 否则 regular 有、bold 没有的字符会在加粗时落回系统等宽，同一行里宽度不一致。
  const covered = new Set([...regular.covered, ...bold.covered]);
  const fullCovered = new Set([...regular.fullCovered, ...bold.fullCovered]);
  const rest = [...fullCovered].filter((cp) => !covered.has(cp));
  if (rest.length === 0) {
    throw new Error('子集覆盖了完整字体的全部码位，拆分没有意义——请收窄 LATIN_SUBSET_RANGES');
  }

  return {
    regular: regular.face,
    bold: bold.face,
    unicodeRange: formatUnicodeRange(toRanges(covered)),
    fullUnicodeRange: formatUnicodeRange(toRanges(rest)),
  };
}
