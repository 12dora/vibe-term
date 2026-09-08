import { PANE_MODE_ALT_SCREEN, PANE_MODE_FLAGS_PRESENT, decodePaneModes } from '@vibeterm/shared';
import type { GatewayPaneHistoryPage, GatewayPaneScreenSnapshot } from '@vibeterm/ws-client';
import type { GhosttyTerminalModeSnapshot, createTerminalController } from 'ghostty-terminal';
import type {
  SnapshotCommitInfo,
  SnapshotWriteOptions,
  TerminalSurfaceTarget,
} from './TerminalSurface';
import { normalizeHistoryForTerminal, normalizeLiveOutputForTerminal } from './normalization';

export const NORMAL_SCREEN_PREFIX = new TextEncoder().encode('\x1b[2J\x1b[H');

export type TerminalController = Awaited<ReturnType<typeof createTerminalController>>;

export interface CanonicalSnapshotTerminal {
  readonly cols?: number;
  readonly rows?: number;
  readonly buffer?: { active: { baseY: number; viewportY: number } };
  reset(): void;
  resize(cols: number, rows: number): void;
  write(data: string | Uint8Array): void;
  restoreModeSnapshot?(snapshot: GhosttyTerminalModeSnapshot): void;
  forceFullRepaint?(): void;
  // biome-ignore lint/suspicious/noConfusingVoidType: 兼容返回 void 的旧实现
  scrollLines?(amount: number): boolean | void;
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

// 快照重建时恢复的终端模式：来自 gateway 随 canonical Screen 下发的 tmux 权威位图
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

// 每页的规范化字节只算一次：history 每到一页都要整屏重排（新页恒更旧、终端无法向上插入），
// 逐页 decode + 正则改写会随页数平方增长，而页对象在 TerminalSurface 里是稳定的副本。
const historyPageChunks = new WeakMap<GatewayPaneHistoryPage, Uint8Array>();

function historyPageChunk(page: GatewayPaneHistoryPage): Uint8Array {
  const cached = historyPageChunks.get(page);
  if (cached !== undefined) return cached;
  // normalizeHistoryForTerminal 会吃掉页尾换行；不补回的话页与页、
  // 最后一页与快照正文会粘在同一行，整屏随之错一行。
  const chunk = new TextEncoder().encode(
    `${normalizeHistoryForTerminal(new TextDecoder().decode(page.data))}\r\n`
  );
  historyPageChunks.set(page, chunk);
  return chunk;
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * 首屏 + history 的完整重写载荷：清屏前缀、按行号升序的 history、快照正文。
 * 一次性拼好再交给终端，避免每页一次 WASM write 与一次渲染调度。
 */
export function buildCanonicalSnapshotPayload(
  snapshot: GatewayPaneScreenSnapshot,
  historyPages: readonly GatewayPaneHistoryPage[]
): Uint8Array {
  // 快照正文是 gateway 用 '\n' 拼接的 capture-pane 行，和 history 一样是裸 LF；直接写进
  // xterm 会阶梯式换行，必须与 history/live 两条路径一样补齐 CR。
  const body = normalizeLiveOutputForTerminal(
    startsWithBytes(snapshot.data, NORMAL_SCREEN_PREFIX) && historyPages.length > 0
      ? snapshot.data.subarray(NORMAL_SCREEN_PREFIX.byteLength)
      : snapshot.data,
    false
  ).normalized;
  if (historyPages.length === 0) return body;
  const chunks: Uint8Array[] = [NORMAL_SCREEN_PREFIX];
  for (const page of historyPages) chunks.push(historyPageChunk(page));
  chunks.push(body);
  return concatChunks(chunks);
}

/** 视口离活动屏底部的行数；读不到视口状态的终端按「停在底部」处理 */
function viewportDistanceFromBottom(terminal: CanonicalSnapshotTerminal): number {
  const active = terminal.buffer?.active;
  if (!active) return 0;
  return Math.max(0, active.baseY - active.viewportY);
}

export function writeCanonicalSnapshot(
  target: CanonicalSnapshotTarget,
  snapshot: GatewayPaneScreenSnapshot,
  historyPages: readonly GatewayPaneHistoryPage[],
  options: SnapshotWriteOptions = {}
): SnapshotCommitInfo {
  // 整屏重排会把视口拉回实时屏底部。history 分页是「在顶部前置更旧的内容」，
  // 重排前后同一「离底部行数」对应同一段内容，据此把用户正在看的位置还原回去；
  // 首屏 / rebase 属于换了一屏内容，跳回实时屏才是对的，故只在分页路径还原。
  const restoreDistance = options.preserveViewport
    ? viewportDistanceFromBottom(target.terminal)
    : 0;
  const gridResized =
    target.terminal.cols !== snapshot.cols || target.terminal.rows !== snapshot.rows;
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
  target.terminal.write(buildCanonicalSnapshotPayload(snapshot, historyPages));
  // 还原放在 forceFullRepaint 之前：整次重排只绘一帧，用户看不到「跳到底再跳回去」
  if (restoreDistance > 0) target.terminal.scrollLines?.(-restoreDistance);
  target.terminal.forceFullRepaint?.();
  return { gridResized };
}

export function writeLiveOutput(target: CanonicalSnapshotTarget, data: Uint8Array): void {
  const normalized = normalizeLiveOutputForTerminal(data, target.liveOutputEndedWithCR);
  target.liveOutputEndedWithCR = normalized.endedWithCR;
  target.terminal.write(normalized.normalized);
}
