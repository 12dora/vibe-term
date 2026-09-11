// 终端字体的空闲预热。
//
// 应用外壳不再强制加载 woff2（见 useAppMonoFont），代价是首次进终端页时要现下字形，
// Ghostty 又必须等字体就绪才能量字宽。折中：首帧之后趁空闲把当前选中的字体拉下来，
// 既不挡首屏，也不让终端从零开始等。ensureTerminalFonts 带进程内缓存，终端启动时
// 命中缓存直接同步返回，重复调用是空操作。
//
// 默认字体已拆成「latin 子集（约 45 KB/字重）+ 完整 Nerd 图标」两段，这里预热的是两段之和，
// 因此调用点（main.tsx）把它排在冷启动预算之后：弱网 / 省流量时干脆不预热。

import { ensureTerminalFonts } from '@vibeterm/terminal-ui/components/hooks/terminal-fonts-cache';

export interface TerminalFontSettings {
  terminalFontId: string;
  terminalFontSize: number;
}

export function warmTerminalFonts(settings: TerminalFontSettings): void {
  void ensureTerminalFonts(settings.terminalFontId, settings.terminalFontSize)?.catch(
    () => undefined
  );
}
