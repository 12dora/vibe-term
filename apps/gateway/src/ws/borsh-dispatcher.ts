import { wsBorsh } from '@tmex/shared';
import type { ServerWebSocket } from 'bun';
import { createAgentKindHandlers } from './agent-kind-handlers';
import type { CanonicalFeedSession } from './canonical-feed-session';
import { createCanonicalKindHandlers } from './canonical-kind-handlers';
import { createTmuxKindHandlers } from './tmux-kind-handlers';
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

export function schemaHandler<T>(
  schema: SchemaLike<T>,
  handle: BorshKindHandler<T>['handle']
): BorshKindHandler<unknown> {
  return {
    schema,
    handle: (ws, decoded, refSeq) => handle(ws, decoded as T, refSeq),
  };
}

export function decoderHandler<T>(
  decode: (payload: Uint8Array) => T,
  handle: BorshKindHandler<T>['handle']
): BorshKindHandler<unknown> {
  return {
    decode,
    handle: (ws, decoded, refSeq) => handle(ws, decoded as T, refSeq),
  };
}

export function createBorshKindHandlers(host: BorshDispatchHost): BorshKindHandlerMap {
  return new Map([
    ...createTmuxKindHandlers(host),
    ...createAgentKindHandlers(host),
    ...createCanonicalKindHandlers(host),
  ]);
}

export function decodeBorshKindPayload<T>(handler: BorshKindHandler<T>, payload: Uint8Array): T {
  if (handler.decode) {
    return handler.decode(payload);
  }
  if (!handler.schema) {
    throw new Error('Borsh kind handler is missing schema and decode');
  }
  try {
    return handler.schema.deserialize(payload);
  } catch (err) {
    throw new wsBorsh.WsBorshError(
      wsBorsh.ERROR_PAYLOAD_DECODE_FAILED,
      false,
      err instanceof Error ? err.message : 'Failed to decode payload'
    );
  }
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
