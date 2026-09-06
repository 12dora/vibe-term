// 终端快捷按钮配色的唯一真源：取自 seoul256 终端主题（@vibeterm/shared/appearance）。
// CSS 变量由 scripts/theme/build-shortcut-tokens.ts 生成到 tokens.generated.css（勿手改）。

import { TERMINAL_THEME_DARK, TERMINAL_THEME_LIGHT } from '@vibeterm/shared';

export interface TerminalShortcutTokens {
  fg: string;
  bg: string;
}

export const TERMINAL_SHORTCUT_TOKENS: Record<'light' | 'dark', TerminalShortcutTokens> = {
  light: { fg: TERMINAL_THEME_LIGHT.foreground, bg: TERMINAL_THEME_LIGHT.background },
  dark: { fg: TERMINAL_THEME_DARK.foreground, bg: TERMINAL_THEME_DARK.background },
};
