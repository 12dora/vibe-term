import type { wsBorsh } from '@tmex/shared';
import type { GatewaySession } from './gateway-session';
import type { TmuxCommandHost } from './tmux-command-handlers';
import * as tmuxCommands from './tmux-command-handlers';

export class WebSocketServerTmuxFacade {
  handleTmuxSelect(
    this: TmuxCommandHost,
    ws: GatewaySession,
    data: wsBorsh.b.infer<typeof wsBorsh.schema.TmuxSelectSchema>
  ): void {
    tmuxCommands.handleTmuxSelect(this, ws, data);
  }

  handleTmuxSelectWindow(this: TmuxCommandHost, deviceId: string, windowId: string): void {
    tmuxCommands.handleTmuxSelectWindow(this, deviceId, windowId);
  }

  handleTermInput(this: TmuxCommandHost, deviceId: string, paneId: string, data: string): void {
    tmuxCommands.handleTermInput(this, deviceId, paneId, data);
  }

  handleCanonicalResize(
    this: TmuxCommandHost,
    session: GatewaySession,
    intent: tmuxCommands.CanonicalResizeIntent
  ): void {
    tmuxCommands.handleCanonicalResize(this, session, intent);
  }

  dropPaneSizeEpochs(this: TmuxCommandHost, session: GatewaySession, deviceId?: string): void {
    tmuxCommands.dropPaneSizeEpochs(session, deviceId);
  }

  handleTermViewport(
    this: TmuxCommandHost,
    session: GatewaySession,
    decoded: wsBorsh.b.infer<typeof wsBorsh.schema.TermViewportSchema>
  ): void {
    tmuxCommands.handleTermViewport(this, session, decoded);
  }

  dropViewportClaims(
    this: TmuxCommandHost,
    session: GatewaySession,
    deviceId?: string,
    options: { recompute?: boolean } = {}
  ): void {
    tmuxCommands.dropViewportClaims(this, session, deviceId, options);
  }

  handleTermPaste(this: TmuxCommandHost, deviceId: string, paneId: string, data: string): void {
    tmuxCommands.handleTermPaste(this, deviceId, paneId, data);
  }

  handleCreateWindow(this: TmuxCommandHost, deviceId: string, name?: string, cwd?: string): void {
    tmuxCommands.handleCreateWindow(this, deviceId, name, cwd);
  }

  handleCloseWindow(this: TmuxCommandHost, deviceId: string, windowId: string): void {
    tmuxCommands.handleCloseWindow(this, deviceId, windowId);
  }

  handleClosePane(this: TmuxCommandHost, deviceId: string, paneId: string): void {
    tmuxCommands.handleClosePane(this, deviceId, paneId);
  }

  renamePane(this: TmuxCommandHost, deviceId: string, paneId: string, name: string): void {
    tmuxCommands.renamePane(this, deviceId, paneId, name);
  }

  handleBreakPane(this: TmuxCommandHost, deviceId: string, paneId: string): void {
    tmuxCommands.handleBreakPane(this, deviceId, paneId);
  }

  handleMovePane(
    this: TmuxCommandHost,
    deviceId: string,
    srcPaneId: string,
    dstPaneId: string,
    position: number
  ): void {
    tmuxCommands.handleMovePane(this, deviceId, srcPaneId, dstPaneId, position);
  }

  renameWindow(this: TmuxCommandHost, deviceId: string, windowId: string, name: string): void {
    tmuxCommands.renameWindow(this, deviceId, windowId, name);
  }

  getCustomNames(
    this: TmuxCommandHost,
    deviceId: string
  ): {
    windows: Record<string, string>;
    panes: Record<string, string>;
  } {
    return tmuxCommands.getCustomNames(this, deviceId);
  }

  handleSetWindowStyle(this: TmuxCommandHost, deviceId: string, style: string): void {
    tmuxCommands.handleSetWindowStyle(this, deviceId, style);
  }

  reorderWindows(this: TmuxCommandHost, deviceId: string, windowIds: string[]): void {
    tmuxCommands.reorderWindows(this, deviceId, windowIds);
  }

  reorderPanes(this: TmuxCommandHost, deviceId: string, windowId: string, paneIds: string[]): void {
    tmuxCommands.reorderPanes(this, deviceId, windowId, paneIds);
  }

  handleResizePaneById(
    this: TmuxCommandHost,
    deviceId: string,
    paneId: string,
    cols?: number,
    rows?: number
  ): void {
    tmuxCommands.handleResizePaneById(this, deviceId, paneId, cols, rows);
  }

  handleApplyStackedLayout(
    this: TmuxCommandHost,
    deviceId: string,
    windowId: string,
    cols: number,
    rows: number
  ): void {
    tmuxCommands.handleApplyStackedLayout(this, deviceId, windowId, cols, rows);
  }

  handleSplitPane(
    this: TmuxCommandHost,
    deviceId: string,
    paneId: string,
    direction: number,
    cwd?: string
  ): void {
    tmuxCommands.handleSplitPane(this, deviceId, paneId, direction, cwd);
  }

  handleFocusPane(this: TmuxCommandHost, deviceId: string, windowId: string, paneId: string): void {
    tmuxCommands.handleFocusPane(this, deviceId, windowId, paneId);
  }

  onStateSnapshotInstalled(this: TmuxCommandHost, deviceId: string): void {
    tmuxCommands.reconcileDeviceViewportSnapshot(this, deviceId);
  }
}
