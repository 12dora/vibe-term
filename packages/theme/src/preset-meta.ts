// 预设元数据：宿主渲染主题选择器（label / 色块预览 / 外观）与终端配色解析的唯一入口。

import { TERMINAL_THEME_DARK, TERMINAL_THEME_LIGHT, type TerminalThemeColors } from '@tmex/shared';
import { PRESET_PALETTES, type ThemeAppearance } from './preset-palettes';
import { THEME_PRESETS, type ThemePreset } from './presets';

export type { ThemeAppearance };

export interface ThemePresetMeta {
  id: ThemePreset;
  /** 品牌名，保持英文原样，不进 i18n */
  label: string;
  appearance: ThemeAppearance;
  /** 选择器色块：背景/前景/强调三色 */
  preview: { background: string; foreground: string; accent: string };
  terminal: TerminalThemeColors;
}

export const THEME_PRESET_META: Record<ThemePreset, ThemePresetMeta> = Object.fromEntries(
  THEME_PRESETS.map((id) => {
    const palette = PRESET_PALETTES[id];
    return [
      id,
      {
        id,
        label: palette.label,
        appearance: palette.appearance,
        preview: {
          background: palette.ui.background,
          foreground: palette.ui.foreground,
          accent: palette.ui.primary,
        },
        terminal: palette.terminal,
      } satisfies ThemePresetMeta,
    ];
  })
) as Record<ThemePreset, ThemePresetMeta>;

/** 预设优先；无预设时回落到站点外观对应的 seoul256 终端配色 */
export function resolveTerminalTheme(
  appearance: ThemeAppearance,
  preset: ThemePreset | null
): TerminalThemeColors {
  if (preset) return THEME_PRESET_META[preset].terminal;
  return appearance === 'light' ? TERMINAL_THEME_LIGHT : TERMINAL_THEME_DARK;
}
