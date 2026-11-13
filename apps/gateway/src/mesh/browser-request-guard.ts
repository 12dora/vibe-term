// 浏览器请求入口门：挡跨站 WebSocket 劫持、跨站 / 同站 CSRF 与（免登录单机下的）DNS 重绑定。
//
// 只看本机直连请求（via=self）；节点间转发进来的流不是浏览器请求。规则：
// - 每个 WebSocket 升级与每个改状态的方法：`Sec-Fetch-Site: cross-site` 直接拒；带 `Origin` 时必须与
//   请求同源，或是本实例自己的入口地址（站点 URL、隧道、本机中继、分享默认地址），否则 403。
//   不带 `Origin` 的请求（CLI、curl、同源 GET）放行。
// - 免登录单机：`Host` 必须是 IP 字面量、localhost / *.localhost、本机 mDNS 名或已配置的域名，否则 421
//   （判定见 request-authority.ts）。有登录门时，同一条规则在特权本机判定（localClientClass）里生效。

import { isKnownEntryOrigin } from './auth-passkey-origin';
import { MESH_VIA_SELF, getMeshRequestContext } from './mesh-deps';
import { authorityAllowed, serverConfiguredHosts, serverEntryOrigins } from './request-authority';
import { publicRequestUrl } from './session-middleware';

export const FOREIGN_ORIGIN = 'FOREIGN_ORIGIN';
export const MISDIRECTED_HOST = 'MISDIRECTED_HOST';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const API_PATH = /^(?:\/n\/[^/]+)?\/api\//;

export type BrowserRequestGuardDeps = {
  /** 免登录单机（standalone 且本机登录门未生效）。 */
  openAccess: () => boolean;
  entryOrigins?: () => ReadonlyArray<string | null | undefined>;
  configuredHosts?: () => readonly string[];
};

function isStateChanging(req: Request): boolean {
  if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') return true;
  return !SAFE_METHODS.has(req.method.toUpperCase());
}

function parseOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** 同主机同端口；TLS 在前置代理终结（页面 https、本机看到 http）也算同源。 */
function sameOriginAsRequest(origin: URL, req: Request): boolean {
  const target = publicRequestUrl(req);
  if (origin.host !== target.host) return false;
  if (origin.protocol === target.protocol) return true;
  return origin.protocol === 'https:' && target.protocol === 'http:';
}

function reject(req: Request, code: string, status: number): Response {
  const pathname = new URL(req.url).pathname;
  if (API_PATH.test(pathname)) {
    return new Response(JSON.stringify({ error: { code } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(code, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

export function guardBrowserRequest(req: Request, deps: BrowserRequestGuardDeps): Response | null {
  if (getMeshRequestContext(req).via !== MESH_VIA_SELF) return null;
  let origins: ReadonlyArray<string | null | undefined> | null = null;
  const entryOrigins = () => {
    origins ??= deps.entryOrigins ? deps.entryOrigins() : serverEntryOrigins();
    return origins;
  };
  const configuredHosts = () =>
    deps.configuredHosts ? deps.configuredHosts() : serverConfiguredHosts(entryOrigins());

  if (deps.openAccess()) {
    const authorities = new Set([new URL(req.url).host, publicRequestUrl(req).host]);
    for (const authority of authorities) {
      if (!authorityAllowed(authority, configuredHosts)) return reject(req, MISDIRECTED_HOST, 421);
    }
  }
  if (!isStateChanging(req)) return null;
  if (req.headers.get('sec-fetch-site')?.toLowerCase() === 'cross-site') {
    return reject(req, FOREIGN_ORIGIN, 403);
  }
  const raw = req.headers.get('origin');
  if (raw === null) return null;
  const origin = parseOrigin(raw);
  if (origin && sameOriginAsRequest(origin, req)) return null;
  if (origin && isKnownEntryOrigin(origin.origin, entryOrigins())) return null;
  return reject(req, FOREIGN_ORIGIN, 403);
}
