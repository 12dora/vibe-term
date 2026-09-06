// 发起节点 X 这一侧：向目标节点 Y 换取窗格授权、随会话持久化、给 RPC 取用。
//
// 换取走 `forwardAuthorizedHttp`：带的是浏览器自己的 `tmex_s_<Y>` 会话——能看到 Y 的窗格
// 就已经登录过 Y，因此不引入新的信任关系。授权以主密钥加密后存进 `agent_sessions.remote_grant`。

import { decrypt, encrypt } from '../../crypto';
import { type AgentSessionRecord, getAgentSessionById, updateAgentSession } from '../../db/agent';
import { getMeshAgentBridge } from '../../mesh/mesh-agent-bridge';
import { PANE_GRANT_ROUTE } from './routes';
import type { PaneGrantRef, PaneGrantSource } from './types';

export interface StoredPaneGrant extends PaneGrantRef {
  nodeId: string;
  deviceId: string;
  paneId: string;
  expiresAt: number;
}

export type PaneGrantMintResult =
  | { kind: 'ok'; grant: StoredPaneGrant }
  /** 目标节点没有这条路由：旧版本，退化成「不带授权」。 */
  | { kind: 'unsupported' }
  /** 浏览器没有目标节点的会话：把 401 原样透给前端，由既有的节点登录提示接手。 */
  | { kind: 'login-required'; response: Response }
  | { kind: 'failed'; status: number };

/** 目标节点不支持授权的记忆窗口：旧节点上每次发消息都去探一次太浪费。 */
const UNSUPPORTED_TTL_MS = 10 * 60_000;
const unsupportedUntil = new Map<string, number>();
const staleSessions = new Set<string>();
const decryptCache = new Map<string, { cipher: string; grant: StoredPaneGrant }>();

export function markSessionGrantStale(sessionId: string): void {
  staleSessions.add(sessionId);
  // 目标节点确实在校验授权，那它就不是「没有签发路由的旧版本」：撤掉记忆，下一次请求立即重签
  const nodeId = getAgentSessionById(sessionId)?.nodeId;
  if (nodeId) unsupportedUntil.delete(nodeId);
}

export function resetPaneGrantClientForTests(): void {
  unsupportedUntil.clear();
  staleSessions.clear();
  decryptCache.clear();
}

async function readMintFailure(res: Response): Promise<PaneGrantMintResult> {
  // 整个读掉再判：留着未消费的 body 会让转发流被中止（日志里的 forward aborted）
  const text = await res.text().catch(() => '');
  let body: { error?: unknown; code?: unknown } = {};
  try {
    body = JSON.parse(text) as { error?: unknown; code?: unknown };
  } catch {
    body = {};
  }
  if (res.status === 401 && body.code === 'NODE_LOGIN_REQUIRED') {
    return {
      kind: 'login-required',
      response: new Response(text, {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    };
  }
  // 路由不存在才是「旧节点」；`device_not_found` 同样是 404，但那是真的错。
  if (res.status === 404 && body.error !== 'device_not_found') {
    return { kind: 'unsupported' };
  }
  return { kind: 'failed', status: res.status };
}

export async function mintPaneGrant(
  req: Request,
  input: { nodeId: string; deviceId: string; paneId: string; now?: number }
): Promise<PaneGrantMintResult> {
  const now = input.now ?? Date.now();
  const bridge = getMeshAgentBridge();
  if (!bridge) return { kind: 'failed', status: 503 };
  if ((unsupportedUntil.get(input.nodeId) ?? 0) > now) return { kind: 'unsupported' };
  const res = await bridge.forwardAuthorizedHttp(req, {
    nodeId: input.nodeId,
    method: 'POST',
    path: PANE_GRANT_ROUTE,
    body: { fromNodeId: bridge.selfNodeId, deviceId: input.deviceId, paneId: input.paneId },
  });
  if (!res.ok) {
    const failure = await readMintFailure(res);
    if (failure.kind === 'unsupported')
      unsupportedUntil.set(input.nodeId, now + UNSUPPORTED_TTL_MS);
    return failure;
  }
  const payload = (await res.json()) as { grantId?: unknown; token?: unknown; expiresAt?: unknown };
  if (typeof payload.grantId !== 'string' || typeof payload.token !== 'string') {
    return { kind: 'failed', status: 502 };
  }
  unsupportedUntil.delete(input.nodeId);
  return {
    kind: 'ok',
    grant: {
      grantId: payload.grantId,
      token: payload.token,
      nodeId: input.nodeId,
      deviceId: input.deviceId,
      paneId: input.paneId,
      expiresAt: typeof payload.expiresAt === 'number' ? payload.expiresAt : 0,
    },
  };
}

export function encryptPaneGrant(grant: StoredPaneGrant): Promise<string> {
  return encrypt(JSON.stringify(grant));
}

async function decryptPaneGrant(cipher: string): Promise<StoredPaneGrant | null> {
  try {
    const parsed = JSON.parse(await decrypt(cipher)) as Partial<StoredPaneGrant>;
    if (typeof parsed.grantId !== 'string' || typeof parsed.token !== 'string') return null;
    if (typeof parsed.nodeId !== 'string' || typeof parsed.paneId !== 'string') return null;
    return parsed as StoredPaneGrant;
  } catch {
    return null;
  }
}

/** 会话上存着的授权（解密结果按密文缓存，热路径上不重复解密）。 */
export async function loadSessionGrant(sessionId: string): Promise<StoredPaneGrant | null> {
  const session = getAgentSessionById(sessionId);
  const cipher = session?.remoteGrant ?? null;
  if (!cipher) {
    decryptCache.delete(sessionId);
    return null;
  }
  const cached = decryptCache.get(sessionId);
  if (cached?.cipher === cipher) return cached.grant;
  const grant = await decryptPaneGrant(cipher);
  if (!grant) {
    decryptCache.delete(sessionId);
    return null;
  }
  decryptCache.set(sessionId, { cipher, grant });
  return grant;
}

function matchesSession(grant: StoredPaneGrant, session: AgentSessionRecord): boolean {
  return (
    grant.nodeId === session.nodeId &&
    grant.deviceId === session.deviceId &&
    grant.paneId === session.paneId
  );
}

/** 到期前一小时就当已过期：跑到一半才失效比提前换一张贵得多。 */
const RENEW_MARGIN_MS = 60 * 60_000;

function needsMint(
  grant: StoredPaneGrant | null,
  session: AgentSessionRecord,
  now: number
): boolean {
  if (staleSessions.has(session.id)) return true;
  if (!grant) return true;
  if (!matchesSession(grant, session)) return true;
  return grant.expiresAt > 0 && grant.expiresAt - RENEW_MARGIN_MS <= now;
}

export type EnsureGrantResult =
  | { ok: true; grant: StoredPaneGrant | null }
  | { ok: false; response: Response };

/**
 * 带用户 cookie 的会话请求（发消息 / 改绑窗格）里补签授权。
 * 目标节点旧版本或暂时够不着都不阻断操作——前者本就不要授权，后者的错误留给运行时报。
 */
export async function ensureSessionGrant(
  req: Request,
  session: AgentSessionRecord,
  now = Date.now()
): Promise<EnsureGrantResult> {
  if (!session.nodeId || !session.deviceId || !session.paneId) return { ok: true, grant: null };
  const current = await loadSessionGrant(session.id);
  if (!needsMint(current, session, now)) return { ok: true, grant: current };
  const minted = await mintPaneGrant(req, {
    nodeId: session.nodeId,
    deviceId: session.deviceId,
    paneId: session.paneId,
    now,
  });
  if (minted.kind === 'login-required') return { ok: false, response: minted.response };
  if (minted.kind !== 'ok') return { ok: true, grant: null };
  await persistSessionGrant(session.id, minted.grant);
  return { ok: true, grant: minted.grant };
}

export async function persistSessionGrant(
  sessionId: string,
  grant: StoredPaneGrant
): Promise<void> {
  const cipher = await encryptPaneGrant(grant);
  updateAgentSession(sessionId, { remoteGrant: cipher });
  decryptCache.set(sessionId, { cipher, grant });
  staleSessions.delete(sessionId);
}

export function sessionPaneGrantSource(sessionId: string): PaneGrantSource {
  return {
    async load() {
      const grant = await loadSessionGrant(sessionId);
      return grant ? { grantId: grant.grantId, token: grant.token } : null;
    },
    reject() {
      markSessionGrantStale(sessionId);
    },
  };
}

/** 建会话时用刚签下、尚未落库的那张。 */
export function staticPaneGrantSource(grant: PaneGrantRef | null): PaneGrantSource {
  return {
    load: async () => grant,
    reject: () => {},
  };
}

/** 删会话时顺手吊销目标节点上的授权（尽力而为：目标够不着就等它自己过期）。 */
export function revokeSessionGrant(req: Request, session: AgentSessionRecord): void {
  if (!session.nodeId || !session.remoteGrant) return;
  const nodeId = session.nodeId;
  void (async () => {
    const grant = await loadSessionGrant(session.id);
    const bridge = getMeshAgentBridge();
    if (!grant || !bridge) return;
    await bridge.forwardAuthorizedHttp(req, {
      nodeId,
      method: 'DELETE',
      path: `${PANE_GRANT_ROUTE}/${encodeURIComponent(grant.grantId)}`,
    });
  })().catch(() => {
    // 吊销失败无害：授权最长 30 天后自然失效
  });
}
