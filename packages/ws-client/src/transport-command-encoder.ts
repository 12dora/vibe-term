// 控制帧编码：每个命令一条 typed handler，映射表由 TS 保证对命令联合完备。
//
// 终端数据面（输入 / 尺寸 / 订阅 / 截屏 / 历史）已整体迁到 canonical 命令，这里只剩
// tmux 控制面与设备连接面；canonical 覆盖的命令没有 legacy 编码器，编码它们即编程错误。

import { wsBorsh } from '@tmex/shared';
import {
  buildDeviceConnect,
  buildDeviceDisconnect,
  buildTermViewportMessage,
  buildTmuxApplyStackedLayout,
  buildTmuxBreakPane,
  buildTmuxClosePane,
  buildTmuxCloseWindow,
  buildTmuxCreateWindow,
  buildTmuxFocusPane,
  buildTmuxMovePane,
  buildTmuxRenamePane,
  buildTmuxRenameWindow,
  buildTmuxReorderPanes,
  buildTmuxReorderWindows,
  buildTmuxResizePane,
  buildTmuxSelect,
  buildTmuxSelectWindow,
  buildTmuxSetWindowStyle,
  buildTmuxSplitPane,
} from './message-builder';
import type { EncodedGatewayCommand, GatewayTransportCommand } from './transport-types';

export function encodeCanonicalGatewayCommand(
  command: wsBorsh.CanonicalCommand,
  effectiveMaxFrameBytes: number
): EncodedGatewayCommand {
  const payload = wsBorsh.encodeCanonicalCommandPayload(command);
  const maxFrameBytes = Math.min(wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES, effectiveMaxFrameBytes);
  if (payload.byteLength + wsBorsh.WS_ENVELOPE_WIRE_OVERHEAD_BYTES > maxFrameBytes) {
    throw new wsBorsh.WsBorshError(
      wsBorsh.ERROR_FRAME_TOO_LARGE,
      false,
      `canonical frame exceeds ${maxFrameBytes} bytes`
    );
  }
  return { kind: wsBorsh.KIND_CANONICAL_COMMAND, payload };
}

type GatewayCommandType = GatewayTransportCommand['type'];

type CommandOf<K extends GatewayCommandType> = Extract<GatewayTransportCommand, { type: K }>;

/** canonical 命令覆盖的命令类型：走 CanonicalStateClient，没有控制帧编码。 */
export const CANONICAL_ONLY_COMMANDS = [
  'terminal-input',
  'terminal-paste',
  'terminal-resize',
  'terminal-sync-size',
  'set-pane-subscriptions',
  'request-pane-screen',
  'request-pane-history',
] as const satisfies readonly GatewayCommandType[];

type CanonicalOnlyCommandType = (typeof CANONICAL_ONLY_COMMANDS)[number];

type ControlCommandType = Exclude<GatewayCommandType, CanonicalOnlyCommandType>;

type CommandEncoders = {
  [K in ControlCommandType]: (command: CommandOf<K>) => EncodedGatewayCommand;
};

const COMMAND_ENCODERS: CommandEncoders = {
  'connect-device': (command) => buildDeviceConnect(command.deviceId),
  'disconnect-device': (command) => buildDeviceDisconnect(command.deviceId),
  'select-pane': (command) => buildTmuxSelect(command),
  'select-window': (command) => buildTmuxSelectWindow(command.deviceId, command.windowId),
  'terminal-viewport': (command) =>
    buildTermViewportMessage({
      deviceId: command.deviceId,
      paneId: command.paneId,
      cols: command.cols,
      rows: command.rows,
      visible: command.visible,
    }),
  'create-window': (command) => buildTmuxCreateWindow(command.deviceId, command.name, command.cwd),
  'close-window': (command) => buildTmuxCloseWindow(command.deviceId, command.windowId),
  'close-pane': (command) => buildTmuxClosePane(command.deviceId, command.paneId),
  'rename-window': (command) =>
    buildTmuxRenameWindow(command.deviceId, command.windowId, command.name),
  'set-window-style': (command) => buildTmuxSetWindowStyle(command.deviceId, command.style),
  'reorder-windows': (command) => buildTmuxReorderWindows(command.deviceId, command.windowIds),
  'resize-pane-in-window': (command) =>
    buildTmuxResizePane(command.deviceId, command.paneId, {
      cols: command.cols,
      rows: command.rows,
    }),
  'apply-stacked-layout': (command) =>
    buildTmuxApplyStackedLayout(command.deviceId, command.windowId, command.cols, command.rows),
  'split-pane': (command) =>
    buildTmuxSplitPane(command.deviceId, command.paneId, command.direction, command.cwd),
  'focus-pane': (command) => buildTmuxFocusPane(command.deviceId, command.windowId, command.paneId),
  'rename-pane': (command) => buildTmuxRenamePane(command.deviceId, command.paneId, command.name),
  'move-pane': (command) =>
    buildTmuxMovePane(command.deviceId, command.srcPaneId, command.dstPaneId, command.position),
  'break-pane': (command) => buildTmuxBreakPane(command.deviceId, command.paneId),
  'reorder-panes': (command) =>
    buildTmuxReorderPanes(command.deviceId, command.windowId, command.paneIds),
};

export function encodeGatewayTransportCommand(
  command: GatewayTransportCommand
): EncodedGatewayCommand {
  const encode = (COMMAND_ENCODERS as Record<string, unknown>)[command.type] as
    | ((command: GatewayTransportCommand) => EncodedGatewayCommand)
    | undefined;
  if (!encode) {
    // canonical 覆盖的命令走 canonical feed；命中这里说明 canonical 会话没建起来，
    // 必须失败而不是静默丢弃或退回已下线的 legacy 帧。
    throw new Error(`[gateway-transport] command has no control frame: ${String(command.type)}`);
  }
  return encode(command);
}
