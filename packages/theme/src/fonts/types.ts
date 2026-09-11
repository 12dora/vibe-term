// 字体 manifest 的类型契约（手写，稳定）。
// 数据由 scripts/fonts/build-fonts.ts 生成到 manifest.generated.ts。

/**
 * 默认终端字体的两段分片：首屏只等 latin 子集（约 45 KB），
 * Nerd 图标等余下字形由完整文件后到。两个 unicode-range 由产物 cmap 反推、严格互补。
 */
export interface FontSubsetFiles {
  /** 子集 woff2（Regular） */
  regular: string;
  /** 子集 woff2（Bold） */
  bold: string;
  /** 子集那一面的 unicode-range */
  unicodeRange: string;
  /** 完整文件那一面的 unicode-range（与上面互补） */
  fullUnicodeRange: string;
}

export interface FontManifestEntry {
  /** 主键 / store 中持久化的值 */
  id: string;
  /** 选择器展示名 */
  displayName: string;
  /** @font-face 用的 CSS family 名 */
  cssFamily: string;
  /** 是否随包分发了 woff2 产物 */
  bundled: boolean;
  /** 是否默认字体（沿用静态 @font-face，无需运行时注入） */
  isDefault?: boolean;
  /** woff2 文件 URL（public 下的绝对路径），用于运行时注入 @font-face 懒加载 */
  files?: { regular: string; bold: string };
  /** latin 子集分片（只有默认字体有：它在冷启动关键路径上） */
  subset?: FontSubsetFiles;
}
