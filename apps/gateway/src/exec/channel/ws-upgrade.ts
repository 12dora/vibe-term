import type { ExecSessionRef } from './transport-types';
import type { ExecWsConnection } from './ws-transport';

export const EXEC_WS_KIND = 'exec-ws';

export type ExecWsData = {
  kind: typeof EXEC_WS_KIND;
  uid: string | null;
  tokenId: string | null;
  session: ExecSessionRef | null;
  conn?: ExecWsConnection;
};

export type ExecUpgradeAuth = {
  uid: string | null;
  tokenId: string | null;
  session?: ExecSessionRef | null;
};

export type ExecUpgradeServer = {
  upgrade(req: Request, options?: { data?: unknown }): boolean;
};

const EXEC_WS_REST = '/api/exec/ws';

function json(code: string, status: number): Response {
  return new Response(JSON.stringify({ code }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function isExecWsPath(path: string, selfNodeId?: string): boolean {
  return (
    path === EXEC_WS_REST ||
    path === `/n/self${EXEC_WS_REST}` ||
    (selfNodeId !== undefined && path === `/n/${selfNodeId}${EXEC_WS_REST}`)
  );
}

function isUpgradeRequest(req: Request): boolean {
  return req.headers.get('upgrade')?.toLowerCase() === 'websocket';
}

/** 免登录的 bare gateway：与 `/ws` 一致，没有鉴权面，统一按无主身份放行。 */
export function authenticateOpenExecUpgrade(): ExecUpgradeAuth {
  return { uid: null, tokenId: null };
}

/**
 * 升级入口：非升级请求 400，鉴权由调用方提供的 `authenticate` 决定
 * （返回 Response 即拒绝，原样回给客户端）。成功升级返回 undefined。
 * 浏览器 Origin 由入口分发的 `guardBrowserRequest` 统一校验。
 */
export function handleExecWsUpgrade(
  req: Request,
  server: ExecUpgradeServer,
  authenticate: (req: Request) => ExecUpgradeAuth | Response
): Response | undefined {
  if (!isUpgradeRequest(req)) return json('upgrade_required', 400);
  const auth = authenticate(req);
  if (auth instanceof Response) return auth;
  const data: ExecWsData = {
    kind: EXEC_WS_KIND,
    uid: auth.uid,
    tokenId: auth.tokenId,
    session: auth.session ?? null,
  };
  return server.upgrade(req, { data }) ? undefined : json('upgrade_failed', 500);
}
