// 终端字体的空闲预热。
//
// 应用外壳不再强制加载 woff2（见 useAppMonoFont），代价是首次进终端页时要现下 2.3 MB，
// Ghostty 又必须等字体就绪才能量字宽。折中：首帧之后趁空闲把当前选中的字体拉下来，
// 既不挡首屏，也不让终端从零开始等。ensureTerminalFonts 带进程内缓存，终端启动时
// 命中缓存直接同步返回，重复调用是空操作。

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
