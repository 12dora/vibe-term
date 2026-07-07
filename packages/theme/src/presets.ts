// 主题预设注册表：themes.css 中 [data-theme-preset="…"] 的名单（宿主据此渲染选择器/校验取值）。
// 应用方式：documentElement.dataset.themePreset = <id>；移除属性回到默认视觉。

export const THEME_PRESETS = [
  'underground',
  'ocean-breeze',
  'forest-whisper',
  'sunset-glow',
  'lavender-dream',
  'rose-garden',
  'lake-view',
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
