// 终端主题色单一真源（前后端共享）。
// 前端 xterm.js 主题、gateway tmux window-style 代答、OSC 11 应答均从此处取值，
// 保证三路颜色强一致。色值源自 seoul256 配色（见 apps/fe/src/components/terminal/theme.ts 历史）。

export interface TerminalThemeColors {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

// seoul256-light：Background 253 (#E1E1E1)，Foreground 239 (#616161)
export const TERMINAL_THEME_LIGHT: TerminalThemeColors = {
  background: '#e1e1e1',
  foreground: '#616161',
  cursor: '#616161',
  selectionBackground: 'rgba(97, 97, 97, 0.25)',
  black: '#171717',
  red: '#bf2172',
  green: '#009799',
  yellow: '#9a7200',
  blue: '#007299',
  magenta: '#9b1d72',
  cyan: '#007173',
  white: '#d9d9d9',
  brightBlack: '#4e4e4e',
  brightRed: '#e12672',
  brightGreen: '#00bddf',
  brightYellow: '#ffdd00',
  brightBlue: '#7299bc',
  brightMagenta: '#e17899',
  brightCyan: '#6fbcbd',
  brightWhite: '#f1f1f1',
};

// seoul256-dark：来自 seoul256-iTerm
export const TERMINAL_THEME_DARK: TerminalThemeColors = {
  background: '#262626',
  foreground: '#d0d0d0',
  cursor: '#c5c5c5',
  selectionBackground: 'rgba(197, 197, 197, 0.25)',
  black: '#000000',
  red: '#ba3c3c',
  green: '#5d876d',
  yellow: '#d5a54e',
  blue: '#887c8d',
  magenta: '#cd6d6d',
  cyan: '#618484',
  white: '#cfcdc3',
  brightBlack: '#000000',
  brightRed: '#ea7171',
  brightGreen: '#7aab7a',
  brightYellow: '#d1d194',
  brightBlue: '#afa3b5',
  brightMagenta: '#e29f9f',
  brightCyan: '#a0aea3',
  brightWhite: '#d0d0d0',
};

export type TerminalThemeName = 'dark' | 'light';

export function getTerminalTheme(name: TerminalThemeName): TerminalThemeColors {
  return name === 'light' ? TERMINAL_THEME_LIGHT : TERMINAL_THEME_DARK;
}

// gateway 用 window-style 代答 tmux 内 OSC 10/11 颜色查询，需与 xterm 主题保持一致
export function getTmuxWindowStyle(theme: TerminalThemeName): string {
  const colors = getTerminalTheme(theme);
  return `fg=${colors.foreground},bg=${colors.background}`;
}

// OSC 11 应答格式：ESC]11;rgb:RRRR/GGGG/BBBB ST，16-bit per channel。
// #NN -> 0xNN * 0x101（如 #26 -> 0x2626），把 8-bit 通道值线性映射到 16-bit。
export function getOsc11ResponseColor(theme: TerminalThemeName): string {
  const { background } = getTerminalTheme(theme);
  return hexToOsc11Rgb(background);
}

function hexToOsc11Rgb(hex: string): string {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  if (!m) {
    throw new Error(`invalid hex color: ${hex}`);
  }
  const to16 = (h: string) => (Number.parseInt(h, 16) * 0x101).toString(16).padStart(4, '0');
  return `rgb:${to16(m[1])}/${to16(m[2])}/${to16(m[3])}`;
}
