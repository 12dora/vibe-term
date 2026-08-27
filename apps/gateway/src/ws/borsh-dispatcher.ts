import { wsBorsh } from '@tmex/shared';
import { createAgentKindHandlers } from './agent-kind-handlers';
import type { CanonicalFeedSession } from './canonical-feed-session';
import { createCanonicalKindHandlers } from './canonical-kind-handlers';
import type { GatewaySession } from './gateway-session';
import { createTmuxKindHandlers } from './tmux-kind-handlers';

type SchemaLike<T> = {
  deserialize: (data: Uint8Array) => T;
};

export interface BorshDispatchHost {
  handleDeviceConnect(session: GatewaySession, deviceId: string): Promise<void>;
  handleDeviceDisconnect(session: GatewaySession, deviceId: string): void;
  handleTmuxSelect(
    session: GatewaySession,
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
  handleSubscribePanes(session: GatewaySession, deviceId: string, paneIds: string[]): void;
  handleFetchPaneHistory(
    session: GatewaySession,
    deviceId: string,
    paneId: string,
    requestToken: Uint8Array
  ): void;
  handleResizePaneById(deviceId: string, paneId: string, cols?: number, rows?: number): void;
  handleApplyStackedLayout(deviceId: string, windowId: string, cols: number, rows: number): void;
  handleSplitPane(deviceId: string, paneId: string, direction: number, cwd?: string): void;
  handleFocusPane(
    session: GatewaySession,
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
    session: GatewaySession,
    decoded: wsBorsh.b.infer<typeof wsBorsh.schema.SiteThemeUpdateC2SSchema>
  ): void;
  getOrCreateCanonicalSession(session: GatewaySession): CanonicalFeedSession;
  sendError(
    session: GatewaySession,
    refSeq: number | null,
    code: number,
    message: string,
    retryable: boolean
  ): void;
}

export type BorshKindHandler<T = unknown> = {
  schema?: SchemaLike<T>;
  decode?: (payload: Uint8Array) => T;
  handle: (session: GatewaySession, decoded: T, refSeq: number) => void | Promise<void>;
};

export type BorshKindHandlerMap = ReadonlyMap<number, BorshKindHandler<unknown>>;

export function schemaHandler<T>(
  schema: SchemaLike<T>,
  handle: BorshKindHandler<T>['handle']
): BorshKindHandler<unknown> {
  return {
    schema,
    handle: (session, decoded, refSeq) => handle(session, decoded as T, refSeq),
  };
}

export function decoderHandler<T>(
  decode: (payload: Uint8Array) => T,
  handle: BorshKindHandler<T>['handle']
): BorshKindHandler<unknown> {
  return {
    decode,
    handle: (session, decoded, refSeq) => handle(session, decoded as T, refSeq),
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
  session: GatewaySession,
  kind: number,
  refSeq: number,
  payload: Uint8Array
): Promise<void> {
  const handler = handlers.get(kind);
  if (!handler) {
    host.sendError(session, refSeq, wsBorsh.ERROR_UNKNOWN_KIND, `Unknown kind: ${kind}`, false);
    return;
  }
  const decoded = decodeBorshKindPayload(handler, payload);
  await handler.handle(session, decoded, refSeq);
}
