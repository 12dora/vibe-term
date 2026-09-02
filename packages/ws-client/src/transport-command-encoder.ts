// 控制帧编码：每个命令一条 typed handler，映射表由 TS 保证对命令联合完备。

import {
  buildDeviceConnect,
  buildDeviceDisconnect,
  buildTermInput,
  buildTermPaste,
  buildTermResize,
  buildTermSyncSize,
  buildTermViewportMessage,
  buildTmuxApplyStackedLayout,
  buildTmuxBreakPane,
  buildTmuxClosePane,
  buildTmuxCloseWindow,
  buildTmuxCreateWindow,
  buildTmuxFetchPaneHistory,
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
  buildTmuxSubscribePanes,
} from './message-builder';
import type { EncodedGatewayCommand, GatewayTransportCommand } from './transport-types';

type GatewayCommandType = GatewayTransportCommand['type'];

type CommandOf<K extends GatewayCommandType> = Extract<GatewayTransportCommand, { type: K }>;

type CommandEncoders = {
  [K in GatewayCommandType]: (command: CommandOf<K>) => EncodedGatewayCommand;
};

const COMMAND_ENCODERS: CommandEncoders = {
  'connect-device': (command) => buildDeviceConnect(command.deviceId),
  'disconnect-device': (command) => buildDeviceDisconnect(command.deviceId),
  'select-pane': (command) => buildTmuxSelect(command),
  'select-window': (command) => buildTmuxSelectWindow(command.deviceId, command.windowId),
  'terminal-input': (command) =>
    buildTermInput(command.deviceId, command.paneId, command.data, command.isComposing),
  'terminal-paste': (command) => buildTermPaste(command.deviceId, command.paneId, command.data),
  'terminal-resize': (command) =>
    buildTermResize(command.deviceId, command.paneId, command.cols, command.rows),
  'terminal-sync-size': (command) =>
    buildTermSyncSize(command.deviceId, command.paneId, command.cols, command.rows),
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
  'set-pane-subscriptions': (command) => buildTmuxSubscribePanes(command.deviceId, command.paneIds),
  'request-pane-screen': (command) =>
    buildTmuxFetchPaneHistory(
      command.deviceId,
      command.paneId,
      command.requestId,
      command.byteLimit
    ),
  'request-pane-history': (command) =>
    buildTmuxFetchPaneHistory(
      command.deviceId,
      command.paneId,
      command.requestId,
      command.byteLimit
    ),
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
  const encode = COMMAND_ENCODERS[command.type] as
    | ((command: GatewayTransportCommand) => EncodedGatewayCommand)
    | undefined;
  if (!encode) {
    // 类型层已穷尽命令联合；运行时命中说明宿主发来了本版本不认识的命令，必须失败而非静默丢弃。
    throw new Error(`[gateway-transport] unsupported command type: ${String(command.type)}`);
  }
  return encode(command);
}
