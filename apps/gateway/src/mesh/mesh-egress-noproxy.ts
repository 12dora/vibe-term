// 出站是否绕过代理：私网字面量，或 NO_PROXY（括号 IPv6、CIDR、端口、前导点后缀、`*`）。
// HTTP 与 WebSocket 共用；Bun 自带 matcher 对不上 `[::1]`。

import {
  canonicalPeerHost,
  classifyRemoteAddress,
  isCgnatIpv4,
  isIpAddressLiteral,
  parseIpv6Words,
} from './address-class';

export function stripHostBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

export function defaultPortForUrl(url: URL): number {
  if (url.port) return Number(url.port);
  if (url.protocol === 'https:' || url.protocol === 'wss:') return 443;
  return 80;
}

export function tokenizeNoProxy(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

export type NoProxyCidr =
  | { version: 4; ip: number; prefix: number }
  | { version: 6; words: number[]; prefix: number };

export type NoProxyToken = { host: string; port: number | null } | { cidr: NoProxyCidr } | '*';

export function parseNoProxyToken(token: string): NoProxyToken {
  if (token === '*') return '*';
  const cidr = parseCidrToken(token);
  if (cidr) return { cidr };
  if (token.startsWith('[')) return parseBracketToken(token);
  const colons = colonCount(token);
  if (colons >= 2) return { host: token.toLowerCase(), port: null };
  return parseHostPortToken(token);
}

export function hostMatchesNoProxy(hostname: string, port: number, raw: string): boolean {
  for (const token of tokenizeNoProxy(raw)) {
    if (tokenMatches(hostname, port, parseNoProxyToken(token))) return true;
  }
  return false;
}

export function urlMatchesNoProxy(url: URL, raw?: string): boolean {
  const noProxy = raw ?? process.env.NO_PROXY ?? process.env.no_proxy ?? '';
  return hostMatchesNoProxy(url.hostname, defaultPortForUrl(url), noProxy);
}

/** 环回 / RFC1918 / CGNAT / 链路本地 / ULA 的 IP 字面量（含括号与 mapped）。 */
export function isPrivateLiteralHost(hostname: string): boolean {
  const host = canonicalPeerHost(hostname);
  if (!host || !isIpAddressLiteral(host)) return false;
  if (classifyRemoteAddress(host) === 'lan') return true;
  return isCgnatIpv4(host);
}

/** system 模式下直连：私网字面量或 NO_PROXY 命中。 */
export function shouldBypassProxy(url: URL, raw?: string): boolean {
  return isPrivateLiteralHost(url.hostname) || urlMatchesNoProxy(url, raw);
}

function tokenMatches(hostname: string, port: number, parsed: NoProxyToken): boolean {
  if (parsed === '*') return true;
  if ('cidr' in parsed) return cidrContainsHost(hostname, parsed.cidr);
  if (parsed.port !== null && parsed.port !== port) return false;
  return hostMatchesToken(hostname, parsed.host);
}

function parseCidrToken(token: string): NoProxyCidr | null {
  const slash = token.lastIndexOf('/');
  if (slash <= 0) return null;
  const prefix = Number(token.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0) return null;
  const addr = stripHostBrackets(token.slice(0, slash)).toLowerCase();
  const v4 = ipv4ToInt(addr);
  if (v4 != null) return prefix <= 32 ? { version: 4, ip: v4, prefix } : null;
  if (prefix > 128) return null;
  const words = parseIpv6Words(addr);
  return words ? { version: 6, words, prefix } : null;
}

function cidrContainsHost(hostname: string, cidr: NoProxyCidr): boolean {
  const host = canonicalPeerHost(hostname);
  if (!host) return false;
  if (cidr.version === 4) {
    const ip = ipv4ToInt(host);
    return ip != null && ipv4InPrefix(ip, cidr.ip, cidr.prefix);
  }
  const words = parseIpv6Words(host);
  return words != null && ipv6InPrefix(words, cidr.words, cidr.prefix);
}

function ipv4ToInt(host: string): number | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = ((n << 8) + o) >>> 0;
  }
  return n;
}

function ipv4InPrefix(ip: number, network: number, prefix: number): boolean {
  if (prefix <= 0) return true;
  if (prefix >= 32) return ip === network;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return ((ip ^ network) & mask) === 0;
}

function ipv6InPrefix(host: number[], network: number[], prefix: number): boolean {
  if (prefix <= 0) return true;
  const bits = Math.min(prefix, 128);
  const full = Math.floor(bits / 16);
  for (let i = 0; i < full; i++) {
    if ((host[i] ?? 0) !== (network[i] ?? 0)) return false;
  }
  const rem = bits % 16;
  if (rem === 0) return true;
  const mask = (0xffff << (16 - rem)) & 0xffff;
  return ((host[full] ?? 0) & mask) === ((network[full] ?? 0) & mask);
}

function parseBracketToken(token: string): NoProxyToken {
  const close = token.indexOf(']');
  if (close === -1) return { host: stripHostBrackets(token).toLowerCase(), port: null };
  const host = token.slice(1, close).toLowerCase();
  const rest = token.slice(close + 1);
  if (!rest.startsWith(':')) return { host, port: null };
  const port = Number(rest.slice(1));
  return { host, port: Number.isFinite(port) ? port : null };
}

function parseHostPortToken(token: string): NoProxyToken {
  const colon = token.lastIndexOf(':');
  if (colon <= 0) return { host: token.toLowerCase(), port: null };
  const port = Number(token.slice(colon + 1));
  if (!Number.isFinite(port) || port <= 0) return { host: token.toLowerCase(), port: null };
  return { host: token.slice(0, colon).toLowerCase(), port };
}

function hostMatchesToken(hostname: string, tokenHost: string): boolean {
  const host = stripHostBrackets(hostname).toLowerCase();
  const token = stripHostBrackets(tokenHost).toLowerCase();
  if (!token) return false;
  if (token.startsWith('.')) {
    const suffix = token.slice(1);
    return Boolean(suffix) && (host === suffix || host.endsWith(`.${suffix}`));
  }
  return host === token || host.endsWith(`.${token}`);
}

function colonCount(value: string): number {
  let n = 0;
  for (const ch of value) if (ch === ':') n += 1;
  return n;
}
