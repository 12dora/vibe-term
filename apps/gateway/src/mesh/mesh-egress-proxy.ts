// 从 HTTP(S)_PROXY / ALL_PROXY 解析 WebSocket 可用的 http(s) 代理；socks 只记一次日志。

import { shouldBypassProxy } from './mesh-egress-noproxy';
import { warnLine } from './mesh-log';

const HTTP_SCHEMES = new Set(['http:', 'https:']);

let socksLogged = false;

type EnvProxy = { key: string; value: string };

export function resetMeshEgressProxyLogForTests(): void {
  socksLogged = false;
}

/** 目标 URL 应走的 http(s) 代理；私网字面量、NO_PROXY 或只有 socks 代理时返回 null。 */
export function httpProxyUrlFor(target: URL): string | null {
  if (shouldBypassProxy(target)) return null;
  const picked = pickProxyRaw(target);
  if (!picked) return null;
  const parsed = parseHttpProxy(picked.value);
  if (parsed === 'socks') {
    noteSocksOnly(picked.key);
    return null;
  }
  return parsed;
}

function pickProxyRaw(target: URL): EnvProxy | null {
  const tls = target.protocol === 'https:' || target.protocol === 'wss:';
  const specific = tls
    ? envFirst('HTTPS_PROXY', 'https_proxy')
    : envFirst('HTTP_PROXY', 'http_proxy');
  return specific ?? envFirst('ALL_PROXY', 'all_proxy');
}

function parseHttpProxy(raw: string): string | 'socks' | null {
  try {
    const proxy = new URL(raw.includes('://') ? raw : `http://${raw}`);
    if (!HTTP_SCHEMES.has(proxy.protocol)) return 'socks';
    return proxy.toString();
  } catch {
    return null;
  }
}

function envFirst(...keys: string[]): EnvProxy | null {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return { key, value };
  }
  return null;
}

function noteSocksOnly(key: string): void {
  if (socksLogged) return;
  socksLogged = true;
  warnLine('[mesh]', `${key} is socks-only; mesh WebSocket connecting direct`);
}
