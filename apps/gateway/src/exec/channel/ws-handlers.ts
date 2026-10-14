import { attachExecChannel } from './attach';
import type { ExecChannelAuth, ExecChannelInbound, ExecTransport } from './transport-types';
import { ExecWsConnection, type ExecWsMessage, type ExecWsSocket } from './ws-transport';
import { EXEC_WS_KIND, type ExecWsData } from './ws-upgrade';

const WS_CLOSE_INTERNAL = 1011;

type ExecWsLike = ExecWsSocket & { data: unknown };

export type AttachExecChannel = (
  transport: ExecTransport,
  auth: ExecChannelAuth
) => ExecChannelInbound;

export function isExecWsSocket(ws: { data?: unknown }): boolean {
  return (ws.data as { kind?: unknown } | null | undefined)?.kind === EXEC_WS_KIND;
}

function connectionOf(ws: { data?: unknown }): ExecWsConnection | undefined {
  return (ws.data as ExecWsData | undefined)?.conn;
}

export function createExecWebSocketHandlers(attach: AttachExecChannel = attachExecChannel) {
  return {
    open(ws: ExecWsLike): void {
      const data = ws.data as ExecWsData;
      const conn = new ExecWsConnection(ws);
      data.conn = conn;
      try {
        conn.attach(attach(conn, { uid: data.uid, tokenId: data.tokenId, session: data.session }));
      } catch {
        conn.close(WS_CLOSE_INTERNAL, 'exec channel unavailable');
      }
    },
    message(ws: { data?: unknown }, message: ExecWsMessage): void {
      connectionOf(ws)?.handleMessage(message);
    },
    drain(ws: { data?: unknown }): void {
      connectionOf(ws)?.handleDrain();
    },
    close(ws: { data?: unknown }): void {
      connectionOf(ws)?.handleClose();
    },
  };
}

export const execWebSocketHandlers = createExecWebSocketHandlers();
