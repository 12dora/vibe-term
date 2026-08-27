import { wsBorsh } from '@tmex/shared';
import { type BorshDispatchHost, type BorshKindHandler, schemaHandler } from './borsh-dispatcher';

export function createTmuxKindHandlers(
  host: BorshDispatchHost
): Array<[number, BorshKindHandler<unknown>]> {
  return [
    [
      wsBorsh.KIND_DEVICE_CONNECT,
      schemaHandler(wsBorsh.schema.DeviceConnectSchema, async (ws, decoded) => {
        await host.handleDeviceConnect(ws, decoded.deviceId);
      }),
    ],
    [
      wsBorsh.KIND_DEVICE_DISCONNECT,
      schemaHandler(wsBorsh.schema.DeviceDisconnectSchema, (ws, decoded) => {
        host.handleDeviceDisconnect(ws, decoded.deviceId);
      }),
    ],
    [
      wsBorsh.KIND_TMUX_SELECT,
      schemaHandler(wsBorsh.schema.TmuxSelectSchema, (ws, decoded) => {
        host.handleTmuxSelect(ws, decoded);
      }),
    ],
    [
      wsBorsh.KIND_TMUX_SELECT_WINDOW,
      schemaHandler(wsBorsh.schema.TmuxSelectWindowSchema, (_ws, decoded) => {
        host.handleTmuxSelectWindow(decoded.deviceId, decoded.windowId);
      }),
    ],
    [
      wsBorsh.KIND_TMUX_CREATE_WINDOW,
      schemaHandler(wsBorsh.schema.TmuxCreateWindowSchema, (_ws, decoded) => {
        host.handleCreateWindow(
          decoded.deviceId,
          decoded.name ?? undefined,
          decoded.cwd ?? undefined
        );
      }),
    ],
    [
      wsBorsh.KIND_TMUX_CLOSE_WINDOW,
      schemaHandler(wsBorsh.schema.TmuxCloseWindowSchema, (_ws, decoded) => {
        host.handleCloseWindow(decoded.deviceId, decoded.windowId);
      }),
    ],
    [
      wsBorsh.KIND_TMUX_CLOSE_PANE,
      schemaHandler(wsBorsh.schema.TmuxClosePaneSchema, (_ws, decoded) => {
        host.handleClosePane(decoded.deviceId, decoded.paneId);
      }),
    ],
    [
      wsBorsh.KIND_TMUX_RENAME_WINDOW,
      schemaHandler(wsBorsh.schema.TmuxRenameWindowSchema, (_ws, decoded) => {
        host.renameWindow(decoded.deviceId, decoded.windowId, decoded.name);
      }),
    ],
    [
      wsBorsh.KIND_TMUX_SET_WINDOW_STYLE,
      schemaHandler(wsBorsh.schema.TmuxSetWindowStyleSchema, (_ws, decoded) => {
        host.handleSetWindowStyle(decoded.deviceId, decoded.style);
      }),
    ],
    [
      wsBorsh.KIND_TMUX_REORDER_WINDOWS,
      schemaHandler(wsBorsh.schema.TmuxReorderWindowsSchema, (_ws, decoded) => {
        host.reorderWindows(decoded.deviceId, decoded.windowIds);
      }),
    ],
    [
      wsBorsh.KIND_TMUX_REORDER_PANES,
      schemaHandler(wsBorsh.schema.TmuxReorderPanesSchema, (_ws, decoded) => {
        host.reorderPanes(decoded.deviceId, decoded.windowId, decoded.paneIds);
      }),
    ],
    [
      wsBorsh.KIND_TMUX_SUBSCRIBE_PANES,
      schemaHandler(wsBorsh.schema.TmuxSubscribePanesSchema, (ws, decoded) => {
        host.handleSubscribePanes(ws, decoded.deviceId, decoded.paneIds);
      }),
    ],
    [
      wsBorsh.KIND_TMUX_FETCH_PANE_HISTORY,
      schemaHandler(wsBorsh.schema.TmuxFetchPaneHistorySchema, (ws, decoded) => {
        host.handleFetchPaneHistory(ws, decoded.deviceId, decoded.paneId, decoded.requestToken);
      }),
    ],
    [
      wsBorsh.KIND_TMUX_RESIZE_PANE,
      schemaHandler(wsBorsh.schema.TmuxResizePaneSchema, (_ws, decoded) => {
        host.handleResizePaneById(
          decoded.deviceId,
          decoded.paneId,
          decoded.cols ?? undefined,
          decoded.rows ?? undefined
        );
      }),
    ],
    [
      wsBorsh.KIND_TMUX_APPLY_STACKED_LAYOUT,
      schemaHandler(wsBorsh.schema.TmuxApplyStackedLayoutSchema, (_ws, decoded) => {
        host.handleApplyStackedLayout(
          decoded.deviceId,
          decoded.windowId,
          decoded.cols,
          decoded.rows
        );
      }),
    ],
    [
      wsBorsh.KIND_TMUX_SPLIT_PANE,
      schemaHandler(wsBorsh.schema.TmuxSplitPaneSchema, (_ws, decoded) => {
        host.handleSplitPane(
          decoded.deviceId,
          decoded.paneId,
          decoded.direction,
          decoded.cwd ?? undefined
        );
      }),
    ],
    [
      wsBorsh.KIND_TMUX_FOCUS_PANE,
      schemaHandler(wsBorsh.schema.TmuxFocusPaneSchema, (ws, decoded) => {
        host.handleFocusPane(ws, decoded.deviceId, decoded.windowId, decoded.paneId);
      }),
    ],
    [
      wsBorsh.KIND_TMUX_RENAME_PANE,
      schemaHandler(wsBorsh.schema.TmuxRenamePaneSchema, (_ws, decoded) => {
        host.renamePane(decoded.deviceId, decoded.paneId, decoded.name);
      }),
    ],
    [
      wsBorsh.KIND_TMUX_MOVE_PANE,
      schemaHandler(wsBorsh.schema.TmuxMovePaneSchema, (_ws, decoded) => {
        host.handleMovePane(
          decoded.deviceId,
          decoded.srcPaneId,
          decoded.dstPaneId,
          decoded.position
        );
      }),
    ],
    [
      wsBorsh.KIND_TMUX_BREAK_PANE,
      schemaHandler(wsBorsh.schema.TmuxBreakPaneSchema, (_ws, decoded) => {
        host.handleBreakPane(decoded.deviceId, decoded.paneId);
      }),
    ],
    [
      wsBorsh.KIND_TERM_INPUT,
      schemaHandler(wsBorsh.schema.TermInputSchema, (_ws, decoded) => {
        if (decoded.isComposing) return;
        host.handleTermInput(
          decoded.deviceId,
          decoded.paneId,
          new TextDecoder().decode(decoded.data)
        );
      }),
    ],
    [
      wsBorsh.KIND_TERM_PASTE,
      schemaHandler(wsBorsh.schema.TermPasteSchema, (_ws, decoded) => {
        host.handleTermPaste(
          decoded.deviceId,
          decoded.paneId,
          new TextDecoder().decode(decoded.data)
        );
      }),
    ],
    [
      wsBorsh.KIND_TERM_RESIZE,
      schemaHandler(wsBorsh.schema.TermResizeSchema, (_ws, decoded) => {
        host.handleTermResize(decoded.deviceId, decoded.paneId, decoded.cols, decoded.rows);
      }),
    ],
    [
      wsBorsh.KIND_TERM_SYNC_SIZE,
      schemaHandler(wsBorsh.schema.TermSyncSizeSchema, (_ws, decoded) => {
        host.handleTermResize(decoded.deviceId, decoded.paneId, decoded.cols, decoded.rows);
      }),
    ],
  ];
}
