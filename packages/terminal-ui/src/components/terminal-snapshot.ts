import { PANE_MODE_ALT_SCREEN, PANE_MODE_FLAGS_PRESENT, decodePaneModes } from '@tmex/shared';
import type { GatewayPaneHistoryPage, GatewayPaneScreenSnapshot } from '@tmex/ws-client';
import type { GhosttyTerminalModeSnapshot, createTerminalController } from 'ghostty-terminal';
import type { TerminalSurfaceTarget } from './TerminalSurface';
import {
  normalizeHistoryForTerminal,
  normalizeLiveOutputForTerminal,
  wrapAlternateScreenHistory,
} from './normalization';

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
  target.terminal.write(buildCanonicalSnapshotPayload(snapshot, historyPages));
  target.terminal.forceFullRepaint?.();
}

export interface TerminalGeometry {
  cols: number;
  rows: number;
}

export interface HistoryRestoreTerminal extends CanonicalSnapshotTerminal {
  readonly cols: number;
  readonly rows: number;
}

export interface HistoryRestoreTarget {
  terminal: HistoryRestoreTerminal;
  liveOutputEndedWithCR: boolean;
}

export interface HistoryRestorePayload {
  data: string;
  alternateScreen: boolean;
  modes: number;
}

// legacy TERM_HISTORY 是 tmux 按 pane 几何拍的整屏 capture：行数按 pane 高度对齐，
// 末尾的光标恢复序列也以 pane 高度为基准做相对上移。写进行数更少的终端时顶部会被
// 挤进 scrollback（切窗回来只剩提示符），光标恢复还会被裁到首行。canonical 快照
// 自带 rows/cols 并在 writeCanonicalSnapshot 里对齐；legacy 路径的几何只能取自
// tmux 快照元数据，这里做同样的对齐。
export function resolveHistoryRestoreGeometry(
  remote: TerminalGeometry | null | undefined,
  current: TerminalGeometry
): TerminalGeometry | null {
  if (!remote) return null;
  if (!Number.isInteger(remote.cols) || !Number.isInteger(remote.rows)) return null;
  if (remote.cols < 2 || remote.rows < 2) return null;
  if (remote.cols === current.cols && remote.rows === current.rows) return null;
  return { cols: remote.cols, rows: remote.rows };
}

export function writeRestoredHistory(
  target: HistoryRestoreTarget,
  payload: HistoryRestorePayload,
  remoteGeometry: TerminalGeometry | null
): void {
  const resize = resolveHistoryRestoreGeometry(remoteGeometry, {
    cols: target.terminal.cols,
    rows: target.terminal.rows,
  });
  if (resize) target.terminal.resize(resize.cols, resize.rows);
  target.terminal.restoreModeSnapshot?.(
    terminalModesFromHistory(payload.modes, payload.alternateScreen)
  );
  target.terminal.write(
    payload.alternateScreen
      ? wrapAlternateScreenHistory(payload.data)
      : normalizeHistoryForTerminal(payload.data)
  );
  target.terminal.forceFullRepaint?.();
}

export function writeLiveOutput(target: CanonicalSnapshotTarget, data: Uint8Array): void {
  const normalized = normalizeLiveOutputForTerminal(data, target.liveOutputEndedWithCR);
  target.liveOutputEndedWithCR = normalized.endedWithCR;
  target.terminal.write(normalized.normalized);
}
