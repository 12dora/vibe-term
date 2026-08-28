// 主题预设注册表：themes.css 中 [data-theme-preset="…"] 的名单（宿主据此渲染选择器/校验取值）。
// 每个预设自带亮/暗外观（见 preset-palettes.ts），选中时宿主须同步把站点外观切到该外观，
// 深色预设的 token 依赖 <html>.dark 才成立。
// 应用方式：documentElement.dataset.themePreset = <id>；移除属性回到默认视觉。

export const THEME_PRESETS = [
  'dracula',
  'tokyo-night',
  'tokyo-night-storm',
  'tokyo-night-light',
  'catppuccin-mocha',
  'catppuccin-latte',
  'nord',
  'one-dark',
  'solarized-dark',
  'solarized-light',
  'gruvbox-dark',
  'gruvbox-light',
  'github-dark',
  'github-light',
] as const;

export type ThemePreset = (typeof THEME_PRESETS)[number];

export function isThemePreset(value: unknown): value is ThemePreset {
  return typeof value === 'string' && (THEME_PRESETS as readonly string[]).includes(value);
}

export function applyThemePreset(preset: ThemePreset | null): void {
  if (typeof document === 'undefined') return;
  if (preset) {
    document.documentElement.dataset.themePreset = preset;
  } else {
    delete document.documentElement.dataset.themePreset;
  }
}
