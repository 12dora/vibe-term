import { wsBorsh } from '@tmex/shared';
import type { ServerWebSocket } from 'bun';
import { agentWsHub } from '../agent/ws-hub';
import { decodeCanonicalCommand } from './borsh/codec-borsh';
import type { CanonicalFeedSession } from './canonical-feed-session';
import type { ClientState } from './types';

type SchemaLike<T> = {
  deserialize: (data: Uint8Array) => T;
};

export interface BorshDispatchHost {
  handleDeviceConnect(ws: ServerWebSocket<ClientState>, deviceId: string): Promise<void>;
  handleDeviceDisconnect(ws: ServerWebSocket<ClientState>, deviceId: string): void;
  handleTmuxSelect(
    ws: ServerWebSocket<ClientState>,
    data: wsBorsh.b.infer<typeof wsBorsh.schema.TmuxSelectSchema>
  ): void;
  handleTmuxSelectWindow(deviceId: string, windowId: string): void;
  handleCreateWindow(deviceId: string, name?: string, cwd?: string): void;
  handleCloseWindow(deviceId: string, windowId: string): void;
  handleClosePane(deviceId: string, paneId: string): void;
  renameWindow(deviceId: string, windowId: string, name: string): void;
  handleSetWindowStyle(deviceId: string, style: string): void;
  reorderWindows(deviceId: string, windowIds: string[]): void;
  reorderPanes(deviceId: string, windowId: string, paneIds: string[]): void;
  handleSubscribePanes(ws: ServerWebSocket<ClientState>, deviceId: string, paneIds: string[]): void;
  handleFetchPaneHistory(
    ws: ServerWebSocket<ClientState>,
    deviceId: string,
    paneId: string,
    requestToken: Uint8Array
  ): void;
  handleResizePaneById(deviceId: string, paneId: string, cols?: number, rows?: number): void;
  handleApplyStackedLayout(deviceId: string, windowId: string, cols: number, rows: number): void;
  handleSplitPane(deviceId: string, paneId: string, direction: number, cwd?: string): void;
  handleFocusPane(
    ws: ServerWebSocket<ClientState>,
    deviceId: string,
    windowId: string,
    paneId: string
  ): void;
  renamePane(deviceId: string, paneId: string, name: string): void;
  handleMovePane(deviceId: string, srcPaneId: string, dstPaneId: string, position: number): void;
  handleBreakPane(deviceId: string, paneId: string): void;
  handleTermInput(deviceId: string, paneId: string, data: string): void;
  handleTermPaste(deviceId: string, paneId: string, data: string): void;
  handleTermResize(deviceId: string, paneId: string, cols: number, rows: number): void;
  handleSiteThemeUpdate(
    ws: ServerWebSocket<ClientState>,
    decoded: wsBorsh.b.infer<typeof wsBorsh.schema.SiteThemeUpdateC2SSchema>
  ): void;
  getOrCreateCanonicalSession(ws: ServerWebSocket<ClientState>): CanonicalFeedSession;
  sendError(
    ws: ServerWebSocket<ClientState>,
    refSeq: number | null,
    code: number,
    message: string,
    retryable: boolean
  ): void;
}

export type BorshKindHandler<T = unknown> = {
  schema?: SchemaLike<T>;
  decode?: (payload: Uint8Array) => T;
  handle: (ws: ServerWebSocket<ClientState>, decoded: T, refSeq: number) => void | Promise<void>;
};

export type BorshKindHandlerMap = ReadonlyMap<number, BorshKindHandler<unknown>>;

function schemaHandler<T>(
  schema: SchemaLike<T>,
  handle: BorshKindHandler<T>['handle']
): BorshKindHandler<unknown> {
  return {
    schema,
    handle: (ws, decoded, refSeq) => handle(ws, decoded as T, refSeq),
  };
}

function decoderHandler<T>(
  decode: (payload: Uint8Array) => T,
  handle: BorshKindHandler<T>['handle']
): BorshKindHandler<unknown> {
  return {
    decode,
    handle: (ws, decoded, refSeq) => handle(ws, decoded as T, refSeq),
  };
}

export function createBorshKindHandlers(host: BorshDispatchHost): BorshKindHandlerMap {
  const handlers = new Map<number, BorshKindHandler<unknown>>([
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
    [
      wsBorsh.KIND_AGENT_SUBSCRIBE,
      schemaHandler(wsBorsh.schema.AgentSubscribeSchema, async (ws, decoded) => {
        await agentWsHub.subscribe(ws, decoded.sessionId);
      }),
    ],
    [
      wsBorsh.KIND_AGENT_UNSUBSCRIBE,
      schemaHandler(wsBorsh.schema.AgentUnsubscribeSchema, (ws, decoded) => {
        agentWsHub.unsubscribe(ws, decoded.sessionId);
      }),
    ],
    [
      wsBorsh.KIND_SITE_THEME_UPDATE,
      schemaHandler(wsBorsh.schema.SiteThemeUpdateC2SSchema, (ws, decoded) => {
        host.handleSiteThemeUpdate(ws, decoded);
      }),
    ],
    [
      wsBorsh.KIND_CANONICAL_COMMAND,
      decoderHandler(decodeCanonicalCommand, async (ws, decoded, refSeq) => {
        try {
          await host.getOrCreateCanonicalSession(ws).handleCommand(decoded.command);
        } catch (error) {
          const protocolError = error instanceof wsBorsh.WsBorshError ? error : null;
          host.sendError(
            ws,
            refSeq,
            protocolError?.code ?? wsBorsh.ERROR_PAYLOAD_DECODE_FAILED,
            protocolError?.message ?? 'Invalid canonical command',
            protocolError?.retryable ?? false
          );
        }
      }),
    ],
  ]);
  return handlers;
}

export function decodeBorshKindPayload<T>(handler: BorshKindHandler<T>, payload: Uint8Array): T {
  if (handler.decode) {
    return handler.decode(payload);
  }
  if (!handler.schema) {
    throw new Error('Borsh kind handler is missing schema and decode');
  }
  return wsBorsh.decodePayload(handler.schema, payload);
}

export async function dispatchBorshKind(
  handlers: BorshKindHandlerMap,
  host: Pick<BorshDispatchHost, 'sendError'>,
  ws: ServerWebSocket<ClientState>,
  kind: number,
  refSeq: number,
  payload: Uint8Array
): Promise<void> {
  const handler = handlers.get(kind);
  if (!handler) {
    host.sendError(ws, refSeq, wsBorsh.ERROR_UNKNOWN_KIND, `Unknown kind: ${kind}`, false);
    return;
  }
  const decoded = decodeBorshKindPayload(handler, payload);
  await handler.handle(ws, decoded, refSeq);
}
