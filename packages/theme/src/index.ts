// 主题模块：终端字体清单与加载、主题预设注册表与元数据
export {
  DEFAULT_FONT_ID,
  FONT_MANIFEST,
  getFontEntry,
  loadTerminalFonts,
  resolveFontStack,
} from './fonts/index';
export type { FontManifestEntry } from './fonts/types';
export {
  applyThemePreset,
  isThemePreset,
  THEME_PRESETS,
  type ThemePreset,
} from './presets';
export {
  resolveTerminalTheme,
  THEME_PRESET_META,
  type ThemeAppearance,
  type ThemePresetMeta,
} from './preset-meta';
export {
  TERMINAL_SHORTCUT_TOKENS,
  type TerminalShortcutTokens,
} from './terminal-shortcut-tokens';
