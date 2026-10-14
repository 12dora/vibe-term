import type { ExecWsConnection } from './ws-transport';

export const EXEC_WS_KIND = 'exec-ws';

export type ExecWsData = {
  kind: typeof EXEC_WS_KIND;
  uid: string | null;
  tokenId: string | null;
  conn?: ExecWsConnection;
};

export type ExecUpgradeAuth = { uid: string | null; tokenId: string | null };

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

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 浏览器发起的升级带 `Origin`，且必须与访问的主机一致，挡住其他站点页面借已登录会话（或免登录部署）
 * 拉起 shell；CLI 等非浏览器客户端不带或带同主机 origin。
 */
function isForeignBrowserOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  const originHost = hostOf(origin);
  if (!originHost) return true;
  const forwarded = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim().toLowerCase();
  const hosts = [new URL(req.url).host.toLowerCase(), req.headers.get('host')?.toLowerCase()];
  return ![...hosts, forwarded].includes(originHost);
}

/** 免登录的 bare gateway：与 `/ws` 一致，没有鉴权面，统一按无主身份放行。 */
export function authenticateOpenExecUpgrade(): ExecUpgradeAuth {
  return { uid: null, tokenId: null };
}

/**
 * 升级入口：非升级请求 400、跨源浏览器 403，鉴权由调用方提供的 `authenticate` 决定
 * （返回 Response 即拒绝，原样回给客户端）。成功升级返回 undefined。
 */
export function handleExecWsUpgrade(
  req: Request,
  server: ExecUpgradeServer,
  authenticate: (req: Request) => ExecUpgradeAuth | Response
): Response | undefined {
  if (!isUpgradeRequest(req)) return json('upgrade_required', 400);
  if (isForeignBrowserOrigin(req)) return json('FORBIDDEN_ORIGIN', 403);
  const auth = authenticate(req);
  if (auth instanceof Response) return auth;
  const data: ExecWsData = { kind: EXEC_WS_KIND, uid: auth.uid, tokenId: auth.tokenId };
  return server.upgrade(req, { data }) ? undefined : json('upgrade_failed', 500);
}
