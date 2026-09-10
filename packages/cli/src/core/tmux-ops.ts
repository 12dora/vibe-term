// tmux / term 两组共用的会话打开与展示helpers。
//
// 打开一次会话 = 建 WS → DEVICE_CONNECT → 等第一份会话树。控制命令发完要等元数据补丁
// 落地才算成功，等待谓词由调用方给。

import type { TmuxPane, TmuxSession, TmuxWindow } from '@vibeterm/shared';
import type { GatewayTransportCommand } from '@vibeterm/ws-client';
import type { CliContext } from './context';
import type { Output } from './output';
import { DeviceSession, type DeviceSessionEvents } from './pane-session';
import type { ParsedTarget } from './resolve';
import { type ResolvedTargetDevice, resolveTargetDevice } from './term-target';

export interface OpenedDeviceSession extends ResolvedTargetDevice {
  session: DeviceSession;
  tree: TmuxSession;
  target: ParsedTarget;
  close(): void;
}

/** 解析目标 → 建 socket → 连设备 → 等会话树。调用方负责 `close()`。 */
export async function openDeviceSession(
  ctx: CliContext,
  raw: string,
  events: DeviceSessionEvents = {}
): Promise<OpenedDeviceSession> {
  const resolved = await resolveTargetDevice(ctx, raw);
  const socket = await ctx.openSocket(resolved.nodeId);
  const session = new DeviceSession(socket.connection.transport, resolved.device.id, events);
  try {
    const tree = await session.connect(ctx.globals.timeoutMs);
    return {
      ...resolved,
      session,
      tree,
      close: () => {
        session.dispose();
        socket.close();
      },
    };
  } catch (error) {
    session.dispose();
    socket.close();
    throw error;
  }
}

/** 发一条 tmux 控制命令并等它在会话树上落地。 */
export async function applyTmuxChange(
  opened: OpenedDeviceSession,
  command: GatewayTransportCommand,
  predicate: (tree: TmuxSession) => boolean,
  what: string,
  timeoutMs: number
): Promise<TmuxSession> {
  opened.session.send(command);
  return opened.session.awaitTreeChange(predicate, timeoutMs, what);
}

export function windowLabel(window: TmuxWindow): string {
  return window.customName ?? window.name;
}

export function paneLabel(pane: TmuxPane): string {
  return pane.customName ?? pane.title ?? '';
}

export function paneRow(pane: TmuxPane): Record<string, unknown> {
  return {
    id: pane.id,
    index: pane.index,
    active: pane.active,
    size: `${pane.width}x${pane.height}`,
    command: pane.currentCommand ?? '',
    path: pane.currentPath ?? '',
    title: paneLabel(pane),
  };
}

/** `tmux ls` 的人读视图：session → window → pane 三层缩进。 */
export function printSessionTree(out: Output, tree: TmuxSession, header: string): void {
  out.line(`${header}  session ${tree.id} (${tree.name})`);
  for (const window of tree.windows) {
    const mark = window.active ? '*' : ' ';
    out.line(`${mark} ${window.index}: ${windowLabel(window)}  ${window.id}`);
    for (const pane of window.panes) {
      const paneMark = pane.active ? '*' : ' ';
      const bits = [
        `${pane.width}x${pane.height}`,
        pane.currentCommand ?? '',
        pane.currentPath ?? '',
      ].filter((item) => item !== '');
      out.line(`   ${paneMark} ${window.index}.${pane.index}: ${pane.id}  ${bits.join('  ')}`);
    }
  }
}

export function windowById(tree: TmuxSession, windowId: string): TmuxWindow | null {
  return tree.windows.find((window) => window.id === windowId) ?? null;
}

export function paneById(tree: TmuxSession, paneId: string): TmuxPane | null {
  for (const window of tree.windows) {
    const pane = window.panes.find((item) => item.id === paneId);
    if (pane) return pane;
  }
  return null;
}

export function windowIds(tree: TmuxSession): Set<string> {
  return new Set(tree.windows.map((window) => window.id));
}

export function paneIds(tree: TmuxSession, windowId?: string): Set<string> {
  const ids = new Set<string>();
  for (const window of tree.windows) {
    if (windowId && window.id !== windowId) continue;
    for (const pane of window.panes) ids.add(pane.id);
  }
  return ids;
}

/** 补丁落地后新出现的那一个 id（新建窗口 / 分屏用）。 */
export function firstNew(before: ReadonlySet<string>, after: Iterable<string>): string | null {
  for (const id of after) {
    if (!before.has(id)) return id;
  }
  return null;
}
