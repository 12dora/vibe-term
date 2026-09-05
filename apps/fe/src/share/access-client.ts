// 被分享人侧的公开接口（契约见 plan §2.3）。
//
// 刻意不走 `ApiClient`：那条路径上挂着全局 401 拦截器，分享页的一次密码错误会被当成
// 「entry 会话失效」把访客踢去登录页。这里直接用 fetch，错误按契约码归一后交给状态机。

export type ShareAccessState = 'active' | 'ended';

export interface ShareAccessInfo {
  id: string;
  name: string;
  state: ShareAccessState;
  expiresAt: number | null;
  authenticated: boolean;
  /** 仅 authenticated 时返回 */
  deviceId?: string;
  windowId?: string;
}

export interface ShareLoginResult {
  expiresAt: number | null;
}

export type ShareAccessErrorCode =
  | 'SHARE_PASSWORD_INVALID'
  | 'SHARE_LOGIN_LOCKED'
  | 'SHARE_ENDED'
  | 'SHARE_NOT_FOUND'
  | 'SHARE_REQUEST_FAILED';

export class ShareAccessError extends Error {
  constructor(
    readonly code: ShareAccessErrorCode,
    readonly status: number,
    readonly retryAfterMs: number | null = null
  ) {
    super(code);
    this.name = 'ShareAccessError';
  }
}

export type ShareFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** `/api/share-access/:id[suffix]`，带上 node 前缀（self 为空串）。 */
export function shareAccessUrl(nodeBase: string, shareId: string, suffix = ''): string {
  return `${nodeBase}/api/share-access/${encodeURIComponent(shareId)}${suffix}`;
}

const KNOWN_CODES = new Set<string>([
  'SHARE_PASSWORD_INVALID',
  'SHARE_LOGIN_LOCKED',
  'SHARE_ENDED',
  'SHARE_NOT_FOUND',
]);

const STATUS_CODES: Record<number, ShareAccessErrorCode> = {
  401: 'SHARE_PASSWORD_INVALID',
  404: 'SHARE_NOT_FOUND',
  410: 'SHARE_ENDED',
  429: 'SHARE_LOGIN_LOCKED',
};

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** 状态码与错误体归一成一个错误码；两者冲突时以错误体里的契约码为准。 */
export function shareAccessErrorFrom(status: number, body: unknown): ShareAccessError {
  const envelope = (body ?? {}) as { code?: unknown; retryAfterMs?: unknown };
  const declared =
    typeof envelope.code === 'string' && KNOWN_CODES.has(envelope.code)
      ? (envelope.code as ShareAccessErrorCode)
      : null;
  const code = declared ?? STATUS_CODES[status] ?? 'SHARE_REQUEST_FAILED';
  const retryAfterMs = code === 'SHARE_LOGIN_LOCKED' ? positiveNumber(envelope.retryAfterMs) : null;
  return new ShareAccessError(code, status, retryAfterMs);
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function request(url: string, init: RequestInit, fetchImpl: ShareFetch): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { credentials: 'same-origin', ...init });
  } catch {
    throw new ShareAccessError('SHARE_REQUEST_FAILED', 0);
  }
  const body = await readJson(res);
  if (!res.ok) throw shareAccessErrorFrom(res.status, body);
  return body;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function parseShareAccessInfo(body: unknown, fallbackId: string): ShareAccessInfo {
  const raw = (body ?? {}) as Record<string, unknown>;
  return {
    id: optionalString(raw.id) ?? fallbackId,
    name: optionalString(raw.name) ?? '',
    state: raw.state === 'ended' ? 'ended' : 'active',
    expiresAt: nullableNumber(raw.expiresAt),
    authenticated: raw.authenticated === true,
    deviceId: optionalString(raw.deviceId),
    windowId: optionalString(raw.windowId),
  };
}

export function getShareAccess(
  nodeBase: string,
  shareId: string,
  fetchImpl: ShareFetch = globalThis.fetch
): Promise<ShareAccessInfo> {
  return request(shareAccessUrl(nodeBase, shareId), { method: 'GET' }, fetchImpl).then((body) =>
    parseShareAccessInfo(body, shareId)
  );
}

export function loginShareAccess(
  nodeBase: string,
  shareId: string,
  password: string,
  fetchImpl: ShareFetch = globalThis.fetch
): Promise<ShareLoginResult> {
  return request(
    shareAccessUrl(nodeBase, shareId, '/login'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    },
    fetchImpl
  ).then((body) => ({ expiresAt: nullableNumber((body as { expiresAt?: unknown })?.expiresAt) }));
}

export function logoutShareAccess(
  nodeBase: string,
  shareId: string,
  fetchImpl: ShareFetch = globalThis.fetch
): Promise<void> {
  return request(shareAccessUrl(nodeBase, shareId, '/logout'), { method: 'POST' }, fetchImpl).then(
    () => undefined
  );
}
