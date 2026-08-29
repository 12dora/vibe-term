import type {
  EventDevicePayload,
  EventType,
  StateSnapshotPayload,
  ThemeMode,
  WebhookEvent,
} from '@tmex/shared';
import type { wsBorsh } from '@tmex/shared';
import type { ServerWebSocket } from 'bun';
import type { DeviceTreeOrderRecord } from '../db';
import type { SettingsNamespace } from '../settings/broadcaster';
import type { TmuxEvent } from '../tmux-client/events';
import type { DeviceConnectionRegistry } from './device-connection-registry';
import type { LegacyFeedBroadcaster } from './legacy-feed-broadcaster';
import type { SnapshotOverlayStore } from './snapshot-overlays';
import type { TerminalOutputBatcher } from './terminal-output-batcher';
import type { ThemeSettingsBroadcaster } from './theme-settings-broadcaster';
import type { TmuxCommandHost } from './tmux-command-handlers';
import * as tmuxCommands from './tmux-command-handlers';
import type { ClientState, DeviceConnectionEntry, WebSocketServerDeps } from './types';

export abstract class WebSocketCommandFacade implements TmuxCommandHost {
  protected abstract readonly registry: DeviceConnectionRegistry;
  protected abstract readonly theme: ThemeSettingsBroadcaster;
  protected abstract readonly overlays: SnapshotOverlayStore;
  protected abstract readonly feed: LegacyFeedBroadcaster;
  abstract readonly terminalOutputBatcher: TerminalOutputBatcher;
  abstract readonly deps: WebSocketServerDeps;
  abstract sendError(
    ws: ServerWebSocket<ClientState>,
    refSeq: number | null,
    code: number,
    message: string,
    retryable: boolean
  ): void;
  abstract sendChunked(
    ws: ServerWebSocket<ClientState>,
    kind: number,
    payload: Uint8Array
  ): boolean;

  get connections() {
    return this.registry.connections;
  }

  get pendingConnectionEntries() {
    return this.registry.pendingConnectionEntries;
  }

  get windowCustomNames() {
    return this.overlays.windowCustomNames;
  }

  get paneCustomNames() {
    return this.overlays.paneCustomNames;
  }

  get currentTheme(): ThemeMode | null {
    return this.theme.currentTheme;
  }

  set currentTheme(value: ThemeMode | null) {
    this.theme.currentTheme = value;
  }

  get lastBroadcastTheme() {
    return this.theme.lastBroadcastTheme;
  }

  get themeSignalLast() {
    return this.theme.themeSignalLast;
  }

  updateDefaultWorkingDir(deviceId: string, dir: string | undefined): void {
    const entry = this.connections.get(deviceId);
    entry?.runtime.updateDefaultWorkingDir(dir);
  }

  getLastSnapshot(deviceId: string): StateSnapshotPayload | null {
    return this.connections.get(deviceId)?.lastSnapshot ?? null;
  }

  async getOrCreateConnectionEntry(
    deviceId: string,
    ws: ServerWebSocket<ClientState>
  ): Promise<DeviceConnectionEntry | null> {
    return this.registry.getOrCreate(deviceId, ws);
  }

  async createDeviceConnectionEntry(
    deviceId: string,
    ws: ServerWebSocket<ClientState>
  ): Promise<DeviceConnectionEntry | null> {
    return this.registry.createEntry(deviceId, ws);
  }

  refreshSnapshotPolling(deviceId: string): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;
    this.registry.clearSnapshotPollTimer(entry);
  }

  async handleDeviceConnect(ws: ServerWebSocket<ClientState>, deviceId: string): Promise<void> {
    await this.registry.handleDeviceConnect(ws, deviceId);
  }

  handleDeviceDisconnect(ws: ServerWebSocket<ClientState>, deviceId: string): void {
    this.registry.handleDeviceDisconnect(ws, deviceId);
  }

  handleTmuxSelect(
    ws: ServerWebSocket<ClientState>,
    data: wsBorsh.b.infer<typeof wsBorsh.schema.TmuxSelectSchema>
  ): void {
    tmuxCommands.handleTmuxSelect(this, ws, data);
  }

  handleTmuxSelectWindow(deviceId: string, windowId: string): void {
    tmuxCommands.handleTmuxSelectWindow(this, deviceId, windowId);
  }

  handleTermInput(deviceId: string, paneId: string, data: string): void {
    tmuxCommands.handleTermInput(this, deviceId, paneId, data);
  }

  handleTermResize(deviceId: string, paneId: string, cols: number, rows: number): void {
    tmuxCommands.handleTermResize(this, deviceId, paneId, cols, rows);
  }

  handleTermPaste(deviceId: string, paneId: string, data: string): void {
    tmuxCommands.handleTermPaste(this, deviceId, paneId, data);
  }

  handleCreateWindow(deviceId: string, name?: string, cwd?: string): void {
    tmuxCommands.handleCreateWindow(this, deviceId, name, cwd);
  }

  handleCloseWindow(deviceId: string, windowId: string): void {
    tmuxCommands.handleCloseWindow(this, deviceId, windowId);
  }

  handleClosePane(deviceId: string, paneId: string): void {
    tmuxCommands.handleClosePane(this, deviceId, paneId);
  }

  renamePane(deviceId: string, paneId: string, name: string): void {
    tmuxCommands.renamePane(this, deviceId, paneId, name);
  }

  handleBreakPane(deviceId: string, paneId: string): void {
    tmuxCommands.handleBreakPane(this, deviceId, paneId);
  }

  handleMovePane(deviceId: string, srcPaneId: string, dstPaneId: string, position: number): void {
    tmuxCommands.handleMovePane(this, deviceId, srcPaneId, dstPaneId, position);
  }

  renameWindow(deviceId: string, windowId: string, name: string): void {
    tmuxCommands.renameWindow(this, deviceId, windowId, name);
  }

  getCustomNames(deviceId: string): {
    windows: Record<string, string>;
    panes: Record<string, string>;
  } {
    return tmuxCommands.getCustomNames(this, deviceId);
  }

  handleSetWindowStyle(deviceId: string, style: string): void {
    tmuxCommands.handleSetWindowStyle(this, deviceId, style);
  }

  handleSiteThemeUpdate(
    ws: ServerWebSocket<ClientState>,
    decoded: wsBorsh.b.infer<typeof wsBorsh.schema.SiteThemeUpdateC2SSchema>
  ): void {
    this.theme.handleSiteThemeUpdate(ws, decoded);
  }

  scheduleTmuxThemeApply(theme: ThemeMode): void {
    this.theme.scheduleTmuxThemeApply(theme);
  }

  broadcastSiteThemeUpdateS2C(theme: ThemeMode): void {
    this.theme.broadcastSiteThemeUpdateS2C(theme);
  }

  broadcastSettingsUpdate(namespace: SettingsNamespace): void {
    this.theme.broadcastSettingsUpdate(namespace);
  }

  broadcastEventNotify(eventType: EventType, event: WebhookEvent): void {
    this.theme.broadcastEventNotify(eventType, event);
  }

  async handleSiteThemeChange(theme: ThemeMode): Promise<void> {
    await this.theme.handleSiteThemeChange(theme);
  }

  applyThemeToDevice(deviceId: string): void {
    this.theme.applyThemeToDevice(deviceId);
  }

  broadcastThemeChange(theme: 'dark' | 'light'): void {
    this.theme.broadcastThemeChange(theme);
  }

  reorderWindows(deviceId: string, windowIds: string[]): void {
    tmuxCommands.reorderWindows(this, deviceId, windowIds);
  }

  reorderPanes(deviceId: string, windowId: string, paneIds: string[]): void {
    tmuxCommands.reorderPanes(this, deviceId, windowId, paneIds);
  }

  handleSubscribePanes(
    ws: ServerWebSocket<ClientState>,
    deviceId: string,
    paneIds: string[]
  ): void {
    tmuxCommands.handleSubscribePanes(this, ws, deviceId, paneIds);
  }

  handleFetchPaneHistory(
    ws: ServerWebSocket<ClientState>,
    deviceId: string,
    paneId: string,
    requestToken: Uint8Array
  ): void {
    tmuxCommands.handleFetchPaneHistory(this, ws, deviceId, paneId, requestToken);
  }

  handleResizePaneById(deviceId: string, paneId: string, cols?: number, rows?: number): void {
    tmuxCommands.handleResizePaneById(this, deviceId, paneId, cols, rows);
  }

  handleApplyStackedLayout(deviceId: string, windowId: string, cols: number, rows: number): void {
    tmuxCommands.handleApplyStackedLayout(this, deviceId, windowId, cols, rows);
  }

  handleSplitPane(deviceId: string, paneId: string, direction: number, cwd?: string): void {
    tmuxCommands.handleSplitPane(this, deviceId, paneId, direction, cwd);
  }

  handleFocusPane(
    ws: ServerWebSocket<ClientState>,
    deviceId: string,
    windowId: string,
    paneId: string
  ): void {
    tmuxCommands.handleFocusPane(this, ws, deviceId, windowId, paneId);
  }

  encodeSnapshotWithOverlays(payload: StateSnapshotPayload): Uint8Array {
    return this.overlays.encodeSnapshotWithOverlays(payload);
  }

  getCachedDeviceTreeOrder(deviceId: string): DeviceTreeOrderRecord {
    return this.overlays.getCachedDeviceTreeOrder(deviceId);
  }

  storeDeviceTreeOrder(order: DeviceTreeOrderRecord): DeviceTreeOrderRecord {
    return this.overlays.storeDeviceTreeOrder(order);
  }

  sendSnapshotToClients(entry: DeviceConnectionEntry, payload: StateSnapshotPayload): void {
    this.feed.sendSnapshotToClients(entry, payload);
  }

  broadcastTerminalOutput(deviceId: string, paneId: string, data: Uint8Array): void {
    this.feed.broadcastTerminalOutput(deviceId, paneId, data);
  }

  async broadcastTmuxEvent(deviceId: string, event: TmuxEvent): Promise<void> {
    await this.feed.broadcastTmuxEvent(deviceId, event);
  }

  async extendTmuxEvent(deviceId: string, event: TmuxEvent): Promise<TmuxEvent> {
    return this.feed.extendTmuxEvent(deviceId, event);
  }

  broadcastStateSnapshot(deviceId: string, payload: StateSnapshotPayload): void {
    this.feed.broadcastStateSnapshot(deviceId, payload);
  }

  broadcastTerminalHistory(
    deviceId: string,
    paneId: string,
    data: string,
    alternateScreen: boolean,
    modes: number
  ): void {
    this.feed.broadcastTerminalHistory(deviceId, paneId, data, alternateScreen, modes);
  }

  broadcastDeviceError(deviceId: string, payload: EventDevicePayload): void {
    this.feed.broadcastDeviceError(deviceId, payload);
  }

  broadcastDeviceEvent(entry: DeviceConnectionEntry, payload: EventDevicePayload): void {
    this.feed.broadcastDeviceEvent(entry, payload);
  }
}
