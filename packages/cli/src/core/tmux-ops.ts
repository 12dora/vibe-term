// tmux / term 两组共用的会话打开与展示helpers。
//
// 打开一次会话 = 建 WS → DEVICE_CONNECT → 等第一份会话树。控制命令发完要等元数据补丁
// 落地才算成功，等待谓词由调用方给。

import type { TmuxPane, TmuxSession, TmuxWindow } from '@vibeterm/shared';
import type {
  GatewayTransport,
  GatewayTransportCommand,
  GatewayTransportEvent,
} from '@vibeterm/ws-client';
import type { CliContext } from './context';
import { NetworkError } from './errors';
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

/**
 * 向网关发 `disconnect-device`，不先 `connect-device`（连接仍由 tmux/term 隐式完成）。
 * 等到本条 WS 收到 `device-disconnected` 再返回。
 */
export async function disconnectDevice(
  ctx: CliContext,
  raw: string
): Promise<ResolvedTargetDevice> {
  return sendDeviceCommand(ctx, raw, 'disconnect-device', 'disconnect');
}

/**
 * 向网关发 `connect-device`，等到 `device-connected` 或第一份会话树快照再返回。
 * 与 `disconnectDevice` 一样用短连接：确认后关 socket，不经过 `DeviceSession`。
 */
export async function connectDevice(ctx: CliContext, raw: string): Promise<ResolvedTargetDevice> {
  return sendDeviceCommand(ctx, raw, 'connect-device', 'connect');
}

async function sendDeviceCommand(
  ctx: CliContext,
  raw: string,
  type: 'connect-device' | 'disconnect-device',
  verb: 'connect' | 'disconnect'
): Promise<ResolvedTargetDevice> {
  const resolved = await resolveTargetDevice(ctx, raw);
  const socket = await ctx.openSocket(resolved.nodeId);
  try {
    await awaitDeviceAck(
      socket.connection.transport,
      resolved.device.id,
      type,
      verb,
      ctx.globals.timeoutMs
    );
    return resolved;
  } finally {
    socket.close();
  }
}

function awaitDeviceAck(
  transport: Pick<GatewayTransport, 'send' | 'onEvent'>,
  deviceId: string,
  type: 'connect-device' | 'disconnect-device',
  verb: 'connect' | 'disconnect',
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new NetworkError(`timed out waiting for device ${deviceId} to ${verb}`));
    }, timeoutMs);
    const unsub = transport.onEvent((event) => {
      if (!isDeviceAck(event, deviceId, verb)) return;
      clearTimeout(timer);
      unsub();
      resolve();
    });
    transport.send({ type, deviceId });
  });
}

function isDeviceAck(
  event: GatewayTransportEvent,
  deviceId: string,
  verb: 'connect' | 'disconnect'
): boolean {
  if (verb === 'disconnect') {
    return event.type === 'device-disconnected' && event.deviceId === deviceId;
  }
  if (event.type === 'device-connected' && event.deviceId === deviceId) return true;
  return event.type === 'metadata-snapshot' && event.snapshot.deviceId === deviceId;
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

/**
 * 自定义名的归一化，与网关 `apps/gateway/src/ws/tmux-command-handlers.ts` 的
 * `renameWindow` / `renamePane` 完全一致：`trim()` + 截到 64 字符，空串表示清除自定义名。
 * 落地谓词必须用同一套归一，否则用户带空格或超长的名字会永远等不到「改好了」。
 */
export function normalizeCustomName(raw: string): string {
  return raw.trim().slice(0, 64);
}

export function customNameMatches(entity: { customName?: string } | null, wanted: string): boolean {
  return entity !== null && (entity.customName ?? '') === wanted;
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

export function windowJson(window: TmuxWindow): Record<string, unknown> {
  return {
    id: window.id,
    index: window.index,
    name: windowLabel(window),
    active: window.active,
    panes: window.panes.length,
  };
}

export function reportWindow(ctx: CliContext, action: string, window: TmuxWindow): void {
  if (ctx.out.json) {
    ctx.out.data({ ok: true, action, window: windowJson(window) });
    return;
  }
  ctx.out.line(`${action}: ${window.id} (${window.index}: ${windowLabel(window)})`);
}

export function reportPane(ctx: CliContext, action: string, pane: TmuxPane): void {
  if (ctx.out.json) {
    ctx.out.data({ ok: true, action, pane: paneRow(pane) });
    return;
  }
  ctx.out.line(`${action}: ${pane.id} (${pane.width}x${pane.height})`);
}

export function reportGone(ctx: CliContext, action: string, id: string): void {
  if (ctx.out.json) {
    ctx.out.data({ ok: true, action, id });
    return;
  }
  ctx.out.line(`${action}: ${id}`);
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
