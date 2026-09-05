import { wsBorsh } from '@tmex/shared';
import type { GatewaySession } from './gateway-session';
import { getShareWsService } from './share-hooks';
import type { SharePaneOracle, ShareScope } from './share-scope';

/**
 * 分享连接越权：ws-borsh 错误码表在 packages/shared（本任务不改），
 * 因此这里用一个不与既有码冲突的私有码 + 固定 message，前端两者任一都能识别。
 */
export const SHARE_FORBIDDEN_CODE = 1501;
export const SHARE_FORBIDDEN_MESSAGE = 'SHARE_FORBIDDEN';

export type ShareKindPolicy = 'device' | 'pane' | 'window' | 'canonical' | 'deny';

const SHARE_KIND_POLICIES = new Map<number, ShareKindPolicy>([
  [wsBorsh.KIND_DEVICE_CONNECT, 'device'],
  [wsBorsh.KIND_DEVICE_DISCONNECT, 'device'],
  [wsBorsh.KIND_TERM_INPUT, 'pane'],
  [wsBorsh.KIND_TERM_PASTE, 'pane'],
  [wsBorsh.KIND_TMUX_RESIZE_PANE, 'pane'],
  [wsBorsh.KIND_TERM_VIEWPORT, 'pane'],
  // 终端页渲染必发的焦点命令：只驱动 tmux 焦点，不改结构，限定在 scope window 内放行。
  [wsBorsh.KIND_TMUX_SELECT, 'window'],
  [wsBorsh.KIND_TMUX_FOCUS_PANE, 'window'],
  [wsBorsh.KIND_CANONICAL_COMMAND, 'canonical'],
]);

export function shareKindPolicy(kind: number): ShareKindPolicy {
  return SHARE_KIND_POLICIES.get(kind) ?? 'deny';
}

function stringField(source: unknown, key: string): string | null {
  const value = (source as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === 'string' && value ? value : null;
}

function canonicalCommandOf(decoded: unknown): wsBorsh.CanonicalCommand | null {
  const command = (decoded as { command?: wsBorsh.CanonicalCommand } | null | undefined)?.command;
  return command && typeof command === 'object' ? command : null;
}

function canonicalCommandPane(
  command: wsBorsh.CanonicalCommand
): wsBorsh.CanonicalPaneTarget | null {
  if ('TerminalInput' in command) return command.TerminalInput.pane;
  if ('ResizePane' in command) return command.ResizePane.pane;
  if ('ResizePaneV11' in command) return command.ResizePaneV11.pane;
  if ('RequestScreen' in command) return command.RequestScreen.pane;
  if ('RequestHistory' in command) return command.RequestHistory.pane;
  return null;
}

/**
 * 订阅命令按 pane 逐个判定：越权 pane 由 CanonicalFeedSession 回 NOT_FOUND 拒绝项，
 * 不能整条拒掉——客户端的订阅集合里可能混着刚被移出 window 的 pane。
 */
function canonicalCommandInScope(
  scope: ShareScope,
  decoded: unknown,
  paneInScope: SharePaneOracle
): boolean {
  const command = canonicalCommandOf(decoded);
  if (!command) return false;
  if ('SetPaneSubscriptions' in command) {
    const subscriptions = [
      ...command.SetPaneSubscriptions.activePanes,
      ...command.SetPaneSubscriptions.hotPanes,
    ];
    return subscriptions.every((item) => item.pane.deviceId === scope.deviceId);
  }
  const pane = canonicalCommandPane(command);
  if (!pane) return false;
  return pane.deviceId === scope.deviceId && paneInScope(pane.deviceId, pane.paneId);
}

export function shareDecodedInScope(
  policy: ShareKindPolicy,
  scope: ShareScope,
  decoded: unknown,
  paneInScope: SharePaneOracle
): boolean {
  if (policy === 'canonical') return canonicalCommandInScope(scope, decoded, paneInScope);
  const deviceId = stringField(decoded, 'deviceId');
  if (deviceId !== scope.deviceId) return false;
  if (policy === 'device') return true;
  const paneId = stringField(decoded, 'paneId');
  if (policy === 'pane') return paneId !== null && paneInScope(deviceId, paneId);
  if (policy !== 'window') return false;
  const windowId = stringField(decoded, 'windowId');
  if (windowId === null && paneId === null) return false;
  if (windowId !== null && windowId !== scope.windowId) return false;
  return paneId === null || paneInScope(deviceId, paneId);
}

function recordCanonicalCommand(scope: ShareScope, decoded: unknown): void {
  const command = canonicalCommandOf(decoded);
  const service = getShareWsService();
  if (!command || !service) return;
  if ('TerminalInput' in command) {
    service.recordInput(scope, command.TerminalInput.pane.paneId, command.TerminalInput.data);
    return;
  }
  if ('ResizePane' in command) {
    const { pane, cols, rows } = command.ResizePane;
    service.recordResize(scope, pane.paneId, cols, rows);
    return;
  }
  if ('ResizePaneV11' in command) {
    const { pane, cols, rows } = command.ResizePaneV11;
    service.recordResize(scope, pane.paneId, cols, rows);
  }
}

/**
 * 录屏日志的输入侧只记录被分享人（分享连接）的按键与尺寸；
 * 输出侧由分享服务自己的 pane consumer 记录，两边互不重复。
 */
export function recordShareCommand(scope: ShareScope, kind: number, decoded: unknown): void {
  if (kind === wsBorsh.KIND_CANONICAL_COMMAND) {
    recordCanonicalCommand(scope, decoded);
    return;
  }
  const paneId = stringField(decoded, 'paneId');
  if (!paneId) return;
  if (kind === wsBorsh.KIND_TERM_INPUT || kind === wsBorsh.KIND_TERM_PASTE) {
    const data = (decoded as { data?: unknown }).data;
    if (data instanceof Uint8Array) getShareWsService()?.recordInput(scope, paneId, data);
    return;
  }
  if (kind !== wsBorsh.KIND_TMUX_RESIZE_PANE) return;
  const { cols, rows } = decoded as { cols?: number | null; rows?: number | null };
  if (typeof cols === 'number' && typeof rows === 'number') {
    getShareWsService()?.recordResize(scope, paneId, cols, rows);
  }
}

/**
 * 设备侧广播（tmux 事件 / 剪贴板 / 设备事件）对分享连接的可见性：
 * 事件必须落在 scope window 的 pane 上，无 pane 归属的事件一律不发。
 */
export function shareVisibleClients(
  clients: Iterable<GatewaySession>,
  deviceId: string,
  paneId: string | null,
  paneInScope: (scope: ShareScope, deviceId: string, paneId: string) => boolean
): Iterable<GatewaySession> {
  let hasShare = false;
  for (const client of clients) {
    if (client.shareScope) {
      hasShare = true;
      break;
    }
  }
  if (!hasShare) return clients;
  const visible: GatewaySession[] = [];
  for (const client of clients) {
    const scope = client.shareScope;
    if (scope && (paneId === null || !paneInScope(scope, deviceId, paneId))) continue;
    visible.push(client);
  }
  return visible;
}
