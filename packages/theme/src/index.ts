// 主题模块：终端字体清单与加载、主题预设注册表与元数据
export {
  DEFAULT_FONT_ID,
  FIRST_PAINT_SAMPLE_TEXT,
  FONT_MANIFEST,
  ensureFontFaceInjected,
  getFontEntry,
  loadTerminalFontStages,
  loadTerminalFonts,
  resolveFontStack,
  type TerminalFontStages,
} from './fonts/index';
export type { FontManifestEntry, FontSubsetFiles } from './fonts/types';
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
