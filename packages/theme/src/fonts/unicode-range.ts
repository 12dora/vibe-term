// manifest 里的 `unicode-range` 字符串解析。
// 二段加载要挑一个「只落在完整文件那一面」的字符去触发下载，这个字符必须与
// 生成的范围保持一致——所以从范围串里取，不在代码里硬编码某个 Nerd 图标码位。

/** 取该 unicode-range 覆盖的第一个码位；解析不出时返回 null */
export function firstCodepointOfRange(unicodeRange: string): number | null {
  for (const part of unicodeRange.split(',')) {
    const match = /^\s*U\+([0-9A-Fa-f]+)/.exec(part);
    if (!match) continue;
    const cp = Number.parseInt(match[1] as string, 16);
    if (Number.isFinite(cp)) return cp;
  }
  return null;
}

/** 取该 unicode-range 覆盖的第一个字符，用作 document.fonts.load 的样本文本 */
export function sampleTextForRange(unicodeRange: string): string | null {
  const cp = firstCodepointOfRange(unicodeRange);
  return cp === null ? null : String.fromCodePoint(cp);
}
