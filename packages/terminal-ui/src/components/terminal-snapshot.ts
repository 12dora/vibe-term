import { PANE_MODE_ALT_SCREEN, PANE_MODE_FLAGS_PRESENT, decodePaneModes } from '@tmex/shared';
import type { GatewayPaneHistoryPage, GatewayPaneScreenSnapshot } from '@tmex/ws-client';
import type { GhosttyTerminalModeSnapshot, createTerminalController } from 'ghostty-terminal';
import type { TerminalSurfaceTarget } from './TerminalSurface';
import { normalizeHistoryForTerminal, normalizeLiveOutputForTerminal } from './normalization';

export const NORMAL_SCREEN_PREFIX = new TextEncoder().encode('\x1b[2J\x1b[H');

export type TerminalController = Awaited<ReturnType<typeof createTerminalController>>;

export interface CanonicalSnapshotTerminal {
  reset(): void;
  resize(cols: number, rows: number): void;
  write(data: string | Uint8Array): void;
  restoreModeSnapshot?(snapshot: GhosttyTerminalModeSnapshot): void;
  forceFullRepaint?(): void;
}

export interface CanonicalSnapshotTarget {
  terminal: CanonicalSnapshotTerminal;
  liveOutputEndedWithCR: boolean;
}

export interface TerminalRenderTarget extends TerminalSurfaceTarget, CanonicalSnapshotTarget {
  terminal: TerminalController;
  mount: HTMLDivElement;
}

export function startsWithBytes(value: Uint8Array, prefix: Uint8Array): boolean {
  return (
    value.byteLength >= prefix.byteLength && prefix.every((byte, index) => value[index] === byte)
  );
}

// history 重建时恢复的终端模式：来自 gateway 随 TermHistory 下发的 tmux 权威位图
// （capture 快照本身不含 DECSET 序列，tmux 的 mouse_*_flag 是唯一可靠来源）。
// 1016/1015/9 无 tmux format 变量、pane 内程序也从未在 tmux 下拿到过这些形态，恒
// false；1007 只影响 alt 屏滚轮行为、同样无 format 变量，alt 屏按惯例开启；alt
// screen 状态本身由 history 前缀（\x1b[?1049h）恢复，这里不设。
export function terminalModesFromHistory(
  modes: number,
  alternateScreen: boolean
): GhosttyTerminalModeSnapshot {
  const flags = decodePaneModes(modes);
  return {
    mouseX10: false,
    mouseNormal: flags.mouseStandard,
    mouseButton: flags.mouseButton,
    mouseAny: flags.mouseAll,
    mouseUtf8: flags.mouseUtf8,
    mouseSgr: flags.mouseSgr,
    mouseSgrPixels: false,
    mouseUrxvt: false,
    altScroll: alternateScreen,
    altScreen1047: false,
    altScreen1049: false,
  };
}

export function writeCanonicalSnapshot(
  target: CanonicalSnapshotTarget,
  snapshot: GatewayPaneScreenSnapshot,
  historyPages: readonly GatewayPaneHistoryPage[]
): void {
  target.terminal.reset();
  target.liveOutputEndedWithCR = false;
  target.terminal.resize(snapshot.cols, snapshot.rows);
  // reset() 会清掉全部 DECSET 私有模式，而快照正文（capture-pane 文本）不含这些序列；
  // 必须在 reset 之后用 gateway 随快照下发的 tmux 权威位图恢复鼠标模式，否则切窗/
  // 冷启动后 TUI 的鼠标 hover/滚轮全部失灵。bit7 未置位说明位图来自旧版 gateway
  // （彼时 bit0 是 alternate screen），不能当鼠标位解码。
  if ((snapshot.modes & PANE_MODE_FLAGS_PRESENT) !== 0) {
    target.terminal.restoreModeSnapshot?.(
      terminalModesFromHistory(snapshot.modes, (snapshot.modes & PANE_MODE_ALT_SCREEN) !== 0)
    );
  }
  // 快照正文是 gateway 用 '\n' 拼接的 capture-pane 行，和 history 一样是裸 LF；直接写进
  // xterm 会阶梯式换行，必须与 history/live 两条路径一样补齐 CR。
  const body = normalizeLiveOutputForTerminal(
    startsWithBytes(snapshot.data, NORMAL_SCREEN_PREFIX) && historyPages.length > 0
      ? snapshot.data.subarray(NORMAL_SCREEN_PREFIX.byteLength)
      : snapshot.data,
    false
  ).normalized;
  if (historyPages.length === 0) {
    target.terminal.write(body);
  } else {
    target.terminal.write(NORMAL_SCREEN_PREFIX);
    const decoder = new TextDecoder();
    for (const page of historyPages) {
      target.terminal.write(normalizeHistoryForTerminal(decoder.decode(page.data)));
      // normalizeHistoryForTerminal 会吃掉页尾换行；不补回的话页与页、
      // 最后一页与快照正文会粘在同一行，整屏随之错一行。
      target.terminal.write('\r\n');
    }
    target.terminal.write(body);
  }
  target.terminal.forceFullRepaint?.();
}

export function writeLiveOutput(target: CanonicalSnapshotTarget, data: Uint8Array): void {
  const normalized = normalizeLiveOutputForTerminal(data, target.liveOutputEndedWithCR);
  target.liveOutputEndedWithCR = normalized.endedWithCR;
  target.terminal.write(normalized.normalized);
}
