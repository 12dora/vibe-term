import { clientIpFromRequest } from './client-ip';
import { encodeJsonBytes } from './ctl';
import { ExecForwardPump, type ExecForwardSocket } from './exec-forward-pump';
import { sessionOrTokenCredential } from './forwarder-credential';
import { rejectClosedLink } from './forwarder-link-state';
import { raceLink } from './forwarder-ws-upgrade';
import { MESH_EXEC_FORWARD_KIND, type MeshUpgradeServer, type PeerLinkProvider } from './mesh-deps';
import { jsonError } from './session-middleware';

export const EXEC_WS_REST_PATH = '/api/exec/ws';

export type ExecForwardSocketData = {
  kind: typeof MESH_EXEC_FORWARD_KIND;
  nodeId: string;
  credential: string;
  pump: ExecForwardPump;
};

type ExecForwardSocketLike = ExecForwardSocket & { data?: unknown };

/** 转发 exec 通道到目标节点用的凭证：会话优先，没有会话才用令牌（`tok:<secret>`）。 */
export function execForwardCredential(req: Request, nodeId: string): string | null {
  return sessionOrTokenCredential(req, nodeId);
}

function isWebSocketUpgrade(req: Request): boolean {
  return req.headers.get('upgrade')?.toLowerCase() === 'websocket';
}

export function upgradeExecForward(
  req: Request,
  server: MeshUpgradeServer,
  nodeId: string,
  deps: { peers: PeerLinkProvider; deadlineMs: number }
): Response | undefined {
  if (!isWebSocketUpgrade(req)) return jsonError('upgrade_required', 400);
  const credential = execForwardCredential(req, nodeId);
  if (!credential) return jsonError('NODE_LOGIN_REQUIRED', 401, { nodeId });
  const clientIp = clientIpFromRequest(req);
  const pump = new ExecForwardPump(async (signal) => {
    const link = await raceLink(deps.peers.getLink(nodeId), deps.deadlineMs, signal);
    await rejectClosedLink(link);
    const open = { type: 'exec', credential, ...(clientIp ? { clientIp } : {}) };
    return link.openStream(encodeJsonBytes(open));
  });
  const data: ExecForwardSocketData = { kind: MESH_EXEC_FORWARD_KIND, nodeId, credential, pump };
  if (!server.upgrade(req, { data })) return jsonError('upgrade_failed', 500);
  return undefined;
}

export function isExecForwardSocket(ws: { data?: unknown }): boolean {
  return (ws.data as { kind?: unknown } | null | undefined)?.kind === MESH_EXEC_FORWARD_KIND;
}

function pumpOf(ws: ExecForwardSocketLike): ExecForwardPump | null {
  return (ws.data as Partial<ExecForwardSocketData> | null | undefined)?.pump ?? null;
}

export const execForwardWebsocket = {
  open(ws: ExecForwardSocketLike): void {
    pumpOf(ws)?.open(ws);
  },
  message(ws: ExecForwardSocketLike, message: unknown): void {
    pumpOf(ws)?.onMessage(message);
  },
  drain(ws: ExecForwardSocketLike): void {
    pumpOf(ws)?.onDrain();
  },
  close(ws: ExecForwardSocketLike): void {
    pumpOf(ws)?.onClose();
  },
};
