// VibeTerm 内部 HTTP 头的单一定义处。
//
// 2.0 起正式名统一为 `x-vibeterm-*`；tmex 时期的 `x-tmex-*` 作为**过渡桥**保留：
// 发送方两个名字都写，读取方新名优先、回退旧名，转发/白名单规则两种前缀都认。
// 全网升级到 ≥ 2.0 之后可以删掉 legacy 一侧（`LEGACY_*` 与 pair.legacy）。

export const VIBETERM_HEADER_PREFIX = 'x-vibeterm-';
export const LEGACY_VIBETERM_HEADER_PREFIX = 'x-tmex-';

export interface HeaderNamePair {
  /** 2.0 起的正式名 */
  readonly name: string;
  /** tmex 时期的旧名，混合版本期继续收发 */
  readonly legacy: string;
}

function headerPair(suffix: string): HeaderNamePair {
  return {
    name: `${VIBETERM_HEADER_PREFIX}${suffix}`,
    legacy: `${LEGACY_VIBETERM_HEADER_PREFIX}${suffix}`,
  };
}

export const SET_SESSION_HEADER = headerPair('set-session');
export const SESSION_RENEWED_HEADER = headerPair('session-renewed');
export const CONNECTION_HEADER = headerPair('connection');
export const MESH_PEER_HEADER = headerPair('mesh-peer');
export const CLIENT_SOURCE_HEADER = headerPair('client-source');
export const SET_SHARE_HEADER = headerPair('set-share');
export const SET_SHARE_MAX_AGE_HEADER = headerPair('set-share-max-age');
export const CLEAR_SHARE_HEADER = headerPair('clear-share');
export const VIA_HEADER = headerPair('via');
export const RELAY_TOKEN_HEADER = headerPair('relay-token');
export const RELAY_ADMIN_TOKEN_HEADER = headerPair('relay-admin-token');
export const FORCE_KEYLOG_HEADER = headerPair('force-keylog');
export const GATEWAY_CHALLENGE_HEADER = headerPair('gateway-challenge');
export const FORWARDED_BY_HEADER = headerPair('forwarded-by');

/** webhook 是第三方契约：新老两组头都发，接收方按自己认识的那组校验。 */
export const WEBHOOK_SIGNATURE_HEADER = headerPair('signature');
export const WEBHOOK_EVENT_HEADER = headerPair('event');
export const WEBHOOK_TIMESTAMP_HEADER = headerPair('timestamp');

/** 转发规则：两种前缀都算 VibeTerm 内部头。 */
export function isVibeTermHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith(VIBETERM_HEADER_PREFIX) || lower.startsWith(LEGACY_VIBETERM_HEADER_PREFIX)
  );
}

export function addHeaderNames(target: Set<string>, ...pairs: HeaderNamePair[]): Set<string> {
  for (const pair of pairs) {
    target.add(pair.name);
    target.add(pair.legacy);
  }
  return target;
}

export function matchesHeaderPair(name: string, pair: HeaderNamePair): boolean {
  const lower = name.toLowerCase();
  return lower === pair.name || lower === pair.legacy;
}

interface HeaderGetter {
  get(name: string): string | null | undefined;
}

/** 读取：新名优先，回退旧名。 */
export function readHeaderPair(source: HeaderGetter, pair: HeaderNamePair): string | null {
  return source.get(pair.name) ?? source.get(pair.legacy) ?? null;
}

export function hasHeaderPair(
  source: { has(name: string): boolean },
  pair: HeaderNamePair
): boolean {
  return source.has(pair.name) || source.has(pair.legacy);
}

/** 从普通 record 读（键大小写不定，逐项比对）。 */
export function readHeaderPairFromRecord(
  headers: Record<string, string | undefined> | null | undefined,
  pair: HeaderNamePair
): string | null {
  if (!headers) return null;
  let legacy: string | null = null;
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === pair.name) return value;
    if (lower === pair.legacy) legacy = value;
  }
  return legacy;
}

/** 写入：两个名字都设，混合版本期对端认哪个都能读到。 */
export function setHeaderPair(headers: Headers, pair: HeaderNamePair, value: string): void {
  headers.set(pair.name, value);
  headers.set(pair.legacy, value);
}

export function deleteHeaderPair(headers: Headers, pair: HeaderNamePair): void {
  headers.delete(pair.name);
  headers.delete(pair.legacy);
}

export function assignHeaderPair<T extends Record<string, string>>(
  headers: T,
  pair: HeaderNamePair,
  value: string
): T {
  (headers as Record<string, string>)[pair.name] = value;
  (headers as Record<string, string>)[pair.legacy] = value;
  return headers;
}
