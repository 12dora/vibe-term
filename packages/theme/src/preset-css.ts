// 由调色板真源渲染 [data-theme-preset="…"] CSS 区块。
// 消费方：scripts/theme/build-theme-presets.ts（写文件）与 presets.test.ts（校验已生成内容未过期）。

import { contrastRatio, ensureContrast } from './color-utils';
import { PRESET_PALETTES, type PresetPalette } from './preset-palettes';
import { THEME_PRESETS } from './presets';

/** themes.css / hljs-terminal-theme.css 中预设区块的起止标记（同一串，成对出现） */
export const PRESET_SECTION_MARKER = '/* Theme presets */';

const AA_CONTRAST = 4.5;

/** 语义 token 顺序与 tokens.css 的 :root 保持一致，便于逐行对读 */
function renderThemeTokens(id: string, palette: PresetPalette): string {
  const { ui } = palette;
  const lines = [
    ['--background', ui.background],
    ['--foreground', ui.foreground],
    ['--card', ui.surface],
    ['--card-foreground', ui.foreground],
    ['--popover', ui.surface],
    ['--popover-foreground', ui.foreground],
    ['--primary', ui.primary],
    ['--primary-foreground', ui.primaryForeground],
    ['--secondary', ui.secondary],
    ['--secondary-foreground', ui.secondaryForeground],
    ['--muted', ui.muted],
    ['--muted-foreground', ui.subtle],
    ['--accent', ui.accent],
    ['--accent-foreground', ui.foreground],
    ['--destructive', ui.destructive],
    ['--border', ui.border],
    ['--input', ui.input],
    ['--ring', ui.primary],
    ['--sidebar', ui.sidebar],
    ['--sidebar-foreground', ui.foreground],
    ['--sidebar-primary', ui.primary],
    ['--sidebar-primary-foreground', ui.primaryForeground],
    ['--sidebar-accent', ui.accent],
    ['--sidebar-accent-foreground', ui.foreground],
    ['--sidebar-border', ui.border],
    ['--sidebar-ring', ui.primary],
  ];
  const body = [
    ...lines.map(([k, v]) => `  ${k}: ${v};`),
    '',
    `  --chat-surface: ${ui.chatSurface};`,
  ].join('\n');
  return `[data-theme-preset="${id}"] {\n${body}\n}`;
}

/** 代码高亮最低可读对比度：低于 AA 但高于 UI 组件线的折中，够读又不至于把配色洗白 */
const CODE_MIN_CONTRAST = 4;

/**
 * 语法高亮取色：优先用方案的常规 ANSI 色（更贴近该终端配色的观感），
 * 常规色对底色达不到 AA 时换用对比更高的 bright 变体（gruvbox/solarized 等暗底方案需要）；
 * 两者都不够（多见于浅底方案的黄/品红）再保色相压暗或提亮到可读线。
 */
function pickReadable(background: string, normal: string, bright: string): string {
  const candidate =
    contrastRatio(normal, background) >= AA_CONTRAST ||
    contrastRatio(normal, background) >= contrastRatio(bright, background)
      ? normal
      : bright;
  return ensureContrast(candidate, background, CODE_MIN_CONTRAST);
}

function renderCodeTokens(id: string, palette: PresetPalette): string {
  const { terminal, ui } = palette;
  const bg = terminal.background;
  const blue = pickReadable(bg, terminal.blue, terminal.brightBlue);
  const green = pickReadable(bg, terminal.green, terminal.brightGreen);
  const yellow = pickReadable(bg, terminal.yellow, terminal.brightYellow);
  const magenta = pickReadable(bg, terminal.magenta, terminal.brightMagenta);
  const cyan = pickReadable(bg, terminal.cyan, terminal.brightCyan);
  const red = pickReadable(bg, terminal.red, terminal.brightRed);
  const lines: [string, string][] = [
    ['--code-bg', bg],
    ['--code-fg', terminal.foreground],
    ['--code-comment', ui.subtle],
    ['--code-keyword', blue],
    ['--code-string', green],
    ['--code-number', yellow],
    ['--code-literal', yellow],
    ['--code-title', magenta],
    ['--code-function', magenta],
    ['--code-builtin', cyan],
    ['--code-type', cyan],
    ['--code-attr', cyan],
    ['--code-variable', cyan],
    ['--code-meta', blue],
    ['--code-tag', blue],
    ['--code-name', blue],
    ['--code-addition', green],
    ['--code-deletion', red],
    ['--code-regexp', cyan],
    ['--code-symbol', yellow],
    ['--code-quote', ui.subtle],
    ['--code-section', magenta],
  ];
  const body = lines.map(([k, v]) => `  ${k}: ${v};`).join('\n');
  return `[data-theme-preset="${id}"] {\n${body}\n}`;
}

function renderSection(render: (id: string, palette: PresetPalette) => string): string {
  const blocks = THEME_PRESETS.map((id) => render(id, PRESET_PALETTES[id]));
  return `\n\n${blocks.join('\n\n')}\n\n`;
}

export function renderPresetCssSections(): { themes: string; hljs: string } {
  return {
    themes: renderSection(renderThemeTokens),
    hljs: renderSection(renderCodeTokens),
  };
}

/** 取出两个标记之间的内容（不含标记本身） */
export function extractPresetSection(css: string): string {
  const start = css.indexOf(PRESET_SECTION_MARKER);
  const end = css.indexOf(PRESET_SECTION_MARKER, start + PRESET_SECTION_MARKER.length);
  if (start === -1 || end === -1) {
    throw new Error('missing preset section markers');
  }
  return css.slice(start + PRESET_SECTION_MARKER.length, end);
}

export function replacePresetSection(css: string, section: string): string {
  const start = css.indexOf(PRESET_SECTION_MARKER);
  const end = css.indexOf(PRESET_SECTION_MARKER, start + PRESET_SECTION_MARKER.length);
  if (start === -1 || end === -1) {
    throw new Error('missing preset section markers');
  }
  return css.slice(0, start + PRESET_SECTION_MARKER.length) + section + css.slice(end);
}
