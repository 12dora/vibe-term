// 精选终端字体清单（issue #14）——build-fonts.ts 的真相源。
// 工具会逐个尝试从 Nerd Fonts release 定位 Mono 的 Regular + Bold 两字重，
// 缺 Bold 的自动跳过并计入跳过报告（不在此硬编码跳过清单）。
// 新增字体只需在此追加一项，重跑 `bun run build:fonts`。

import type { CodepointRange } from './font-cmap';

export const NERD_FONTS_VERSION = 'v3.4.0';
export const NERD_FONTS_RELEASE_BASE = `https://github.com/ryanoasis/nerd-fonts/releases/download/${NERD_FONTS_VERSION}`;

/**
 * 默认终端字体的「首屏子集」码位范围：拉丁 + 变音 + 希腊 / 西里尔、标点、货币、箭头、
 * 数学、制表符（框线 / 块元素 / 几何图形）、常用符号与 Powerline 段（U+E0A0–E0D4）。
 * 覆盖的是「一屏 shell 提示符 + 命令输出」真正会用到的字形；Nerd Fonts 其余 PUA 图标
 * 留给完整文件后到再重绘。整份 1.16 MB 子集后约 45 KB，终端首帧不再等 2.3 MB。
 */
export const LATIN_SUBSET_RANGES: readonly CodepointRange[] = [
  [0x0000, 0x02ff], // ASCII / Latin-1 / Latin Extended-A,B / IPA / 修饰符
  [0x0300, 0x036f], // 组合变音
  [0x0370, 0x03ff], // 希腊（λ π σ 常见于提示符）
  [0x0400, 0x04ff], // 西里尔
  [0x1e00, 0x1eff], // Latin Extended Additional
  [0x2000, 0x206f], // 通用标点
  [0x2070, 0x209f], // 上 / 下标
  [0x20a0, 0x20cf], // 货币
  [0x2100, 0x218f], // 类字母符号 / 数字形式
  [0x2190, 0x21ff], // 箭头
  [0x2200, 0x22ff], // 数学运算符
  [0x2300, 0x23ff], // 杂项技术（⌘ ⏎ ⏳）
  [0x2400, 0x24ff], // 控制图形 / OCR / 带圈字母数字
  [0x2500, 0x259f], // 制表符 + 块元素
  [0x25a0, 0x25ff], // 几何图形
  [0x2600, 0x26ff], // 杂项符号
  [0x2700, 0x27bf], // 装饰符号
  [0x27c0, 0x27ff], // 杂项数学 A / 补充箭头 A
  [0x2900, 0x297f], // 补充箭头 B
  [0x2b00, 0x2bff], // 杂项符号与箭头
  [0xe0a0, 0xe0d4], // Powerline 分隔符（提示符几乎每屏都有）
  [0xfe00, 0xfe0f], // 变体选择符
  [0xfffd, 0xfffd], // 替换字符
];

export interface FontSource {
  /** manifest 主键 / store 中持久化的值 / 产物目录名 */
  id: string;
  /** 选择器展示名（纯文本，无字样预览） */
  displayName: string;
  /** @font-face 用的 CSS family 名（避免与系统同名字体冲突，统一加 VibeTerm 后缀） */
  cssFamily: string;
  /** Nerd Fonts release 资产名（zip）。useExisting 时忽略 */
  asset?: string;
  /**
   * 压缩包内字体文件名前缀（去空格、忽略大小写后比较）。
   * 工具匹配 `<matchPrefix>NerdFontMono-<Regular|Bold>.{ttf,otf}`。
   * 注意：与 asset 可能不同（如 BlexMono 在 IBMPlexMono.zip 内、文件名前缀仍是 BlexMono）。
   */
  matchPrefix?: string;
  /** 同名多套时，路径需包含这些 token（如 JetBrains 偏好 Ligatures） */
  preferPathTokens?: string[];
  /** 排除路径含这些 token 的文件（如 NoLigatures / Extended / 宽度变体） */
  excludePathTokens?: string[];
  /** 默认字体：沿用仓库已有的扁平 woff2（已静态 @font-face），不下载、不进 generated */
  useExisting?: { regular: string; bold: string };
  /** 是否默认选中 */
  isDefault?: boolean;
  /**
   * 生成 latin 子集分片（仅默认字体需要）：值是两个字重的产物 URL。
   * 其余字体只在用户显式选中后才加载，不在冷启动关键路径上，保持整份懒加载。
   */
  latinSubset?: { regular: string; bold: string };
}

export const FONTS: FontSource[] = [
  {
    id: 'geist-mono',
    displayName: 'Geist Mono',
    cssFamily: 'GeistMonoVibeTerm',
    isDefault: true,
    useExisting: {
      regular: '/fonts/GeistMonoNerdFontMono-Regular.woff2',
      bold: '/fonts/GeistMonoNerdFontMono-Bold.woff2',
    },
    latinSubset: {
      regular: '/fonts/GeistMonoNerdFontMono-Regular-latin.woff2',
      bold: '/fonts/GeistMonoNerdFontMono-Bold-latin.woff2',
    },
  },
  {
    id: 'jetbrains-mono',
    displayName: 'JetBrains Mono',
    cssFamily: 'JetBrainsMonoVibeTerm',
    asset: 'JetBrainsMono.zip',
    matchPrefix: 'JetBrainsMono',
    excludePathTokens: ['NoLigatures'],
  },
  {
    id: 'fira-code',
    displayName: 'Fira Code',
    cssFamily: 'FiraCodeVibeTerm',
    asset: 'FiraCode.zip',
    matchPrefix: 'FiraCode',
  },
  {
    id: 'blex-mono',
    displayName: 'Blex Mono (IBM Plex Mono)',
    cssFamily: 'BlexMonoVibeTerm',
    asset: 'IBMPlexMono.zip',
    matchPrefix: 'BlexMono',
  },
  {
    id: 'noto-sans-mono',
    displayName: 'Noto Sans Mono',
    cssFamily: 'NotoSansMVibeTerm',
    asset: 'Noto.zip',
    matchPrefix: 'NotoSansM',
  },
  {
    id: 'zed-mono',
    displayName: 'Zed Mono',
    cssFamily: 'ZedMonoVibeTerm',
    asset: 'ZedMono.zip',
    matchPrefix: 'ZedMono',
    excludePathTokens: ['Extended'],
  },
  {
    id: 'victor-mono',
    displayName: 'Victor Mono',
    cssFamily: 'VictorMonoVibeTerm',
    asset: 'VictorMono.zip',
    matchPrefix: 'VictorMono',
  },
  // 以下三个上游缺 Bold，工具会自动跳过并报告；保留在清单内以便将来上游补字重时自动纳入。
  {
    id: '3270',
    displayName: '3270',
    cssFamily: 'IbmThreeTwoSevenZeroVibeTerm',
    asset: '3270.zip',
    matchPrefix: '3270',
  },
  {
    id: 'big-blue-term',
    displayName: 'BigBlue Terminal',
    cssFamily: 'BigBlueTermVibeTerm',
    asset: 'BigBlueTerminal.zip',
    matchPrefix: 'BigBlueTerm',
  },
  {
    id: 'departure-mono',
    displayName: 'Departure Mono',
    cssFamily: 'DepartureMonoVibeTerm',
    asset: 'DepartureMono.zip',
    matchPrefix: 'DepartureMono',
  },
];
