// mesh 鉴权 REST 客户端。所有 `/n/:T/...` 路径由 nodeId 决定，`self` 退化为不带前缀的旧路由。

import { type ApiClient, defaultApiClient, parseApiError } from '../client';
import { SELF_NODE_ID, resolveNodeUrl } from '../node-url';
import { NoPasskeyForOriginError, X_TMEX_CONNECTION_HEADER } from './types';
import type {
  AuthChallengeResponse,
  AuthLoginErrorCode,
  AuthLoginRequest,
  AuthLoginResponse,
  AuthModeResponse,
  AuthTotpRecordResponse,
  KeyLogAppendRequest,
  KeyLogAppendResult,
  KeyLogHeadResponse,
  MeshConnectionResponse,
  MeshConnectionResult,
  MeshHubsResponse,
  MeshNode,
  MeshNodesResponse,
  PasskeyRegistrationVerified,
  PasskeySummary,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  PublicNode,
  PublicNodesResponse,
  RegistrationResponseJSON,
} from './types';

export { SELF_NODE_ID };

/**
 * `self` → 原路径；其余 → `/n/<id>` 前缀。
 * 与 `node-url.ts` 共用同一个 `assertNodeId`：非法 nodeId 直接抛，不靠 URL 编码兜底。
 */
export function nodeAuthPath(nodeId: string, path: string): string {
  return resolveNodeUrl(nodeId, path);
}

export type LoginResult =
  | { ok: true; response: AuthLoginResponse }
  | { ok: false; status: number; code: AuthLoginErrorCode };

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

async function readCode(res: Response, fallback: string): Promise<string> {
  try {
    const payload = (await res.json()) as { code?: unknown; error?: unknown };
    if (typeof payload.code === 'string') return payload.code;
    if (typeof payload.error === 'string') return payload.error;
  } catch {
    // 落到 fallback
  }
  return fallback;
}

/**
 * 抛异常的端点也必须把服务端的 `{code}` 原样带出去。
 *
 * 只留 message 的话，调用方（登录页的 `loginErrorKeyFromException`）读不到码，会把
 * `PASSKEY_REQUIRED` / `NO_PASSKEY_FOR_ORIGIN` 这类**结论性**失败一律显示成「网络错误」。
 */
function requestError(code: string, status: number, message: string): Error {
  return Object.assign(new Error(message), { code, status });
}

/** 读一次错误信封：`code` 用于分支判定，`error`/兜底文案用于 message。 */
async function readErrorEnvelope(
  res: Response,
  fallback: string
): Promise<{ code: string; message: string }> {
  let code = '';
  let message = '';
  try {
    const payload = (await res.json()) as { code?: unknown; error?: unknown };
    if (typeof payload.code === 'string') code = payload.code;
    if (typeof payload.error === 'string') message = payload.error;
    else if (payload.error && typeof payload.error === 'object') {
      const inner = (payload.error as { message?: unknown }).message;
      if (typeof inner === 'string') message = inner;
    }
  } catch {
    // 非 JSON 响应：只剩兜底文案
  }
  return { code: code || `HTTP_${res.status}`, message: message || code || fallback };
}

export class AuthApi {
  constructor(private readonly client: ApiClient = defaultApiClient) {}

  /** standalone 下 `mode==='none'`，登录相关 UI 全部不渲染。 */
  async getMode(): Promise<AuthModeResponse> {
    const res = await this.client.fetch('/api/auth/mode');
    if (!res.ok) {
      throw new Error(await parseApiError(res, 'Failed to load auth mode'));
    }
    return (await res.json()) as AuthModeResponse;
  }

  /** `GET /api/mesh/nodes`（**需会话**）：含公钥 / inventory / loggedIn / isHub。 */
  async listNodes(): Promise<MeshNode[]> {
    const res = await this.client.fetch('/api/mesh/nodes');
    if (!res.ok) {
      throw new Error(await parseApiError(res, 'Failed to load mesh nodes'));
    }
    const payload = (await res.json()) as MeshNodesResponse;
    return payload.nodes ?? [];
  }

  /**
   * `GET /api/mesh/hubs`（**需会话**）：hub 集合、本机 uplink 当前挂载的那台、writer 是谁。
   *
   * 缺字段一律补成空集合而不是抛错：旧入口（1.1.10 及以前）没有这条路由，此时调用方
   * 只会拿到「一台 hub 都不知道」，UI 退化成单 hub 形态，不该整页报错。
   */
  async listHubs(): Promise<MeshHubsResponse> {
    const res = await this.client.fetch('/api/mesh/hubs');
    if (!res.ok) {
      throw new Error(await parseApiError(res, 'Failed to load mesh hubs'));
    }
    const payload = (await res.json()) as Partial<MeshHubsResponse>;
    return {
      hubs: payload.hubs ?? [],
      attached: payload.attached ?? null,
      writerHubId: payload.writerHubId ?? null,
      candidates: (payload.candidates ?? []).map((row) => ({
        publicUrl: row.publicUrl,
        lastError: row.lastError ?? null,
        lastAttemptAt: row.lastAttemptAt ?? null,
        ...(row.rttMs !== undefined ? { rttMs: row.rttMs } : {}),
        ...(row.rttAt !== undefined ? { rttAt: row.rttAt } : {}),
      })),
    };
  }

  /**
   * `GET /api/auth/nodes`（**公开**）：只有 `{id, name, online}`。
   * 登录页在拿到 `tmex_s_self` 之前只能用它——公钥要登录后才下发。
   */
  async listPublicNodes(): Promise<PublicNode[]> {
    const res = await this.client.fetch('/api/auth/nodes');
    if (!res.ok) {
      throw new Error(await parseApiError(res, 'Failed to load nodes'));
    }
    const payload = (await res.json()) as PublicNodesResponse;
    return payload.nodes ?? [];
  }

  /**
   * `GET /api/mesh/connection`（**需会话**）：拿到本标签页那条 Gateway WS 在目标 node
   * 上的 `connectionId`。直连授权（`POST /api/rtc/authorize`）必须带它，否则同 sid 多标签
   * 时 node 不知道把直连挂到哪条会话上。
   *
   * 定位方式二选一：`cid`（本条 WS 握手时带的 client nonce，多标签唯一可靠的一种）或
   * `connectionId`（已知服务端 id 时的复核）。两个都不给且该 sid 有多条 live WS → 409。
   *
   * 失败不抛异常：`404 NO_CONNECTION`（primary 还没连上 / nonce 未登记）与
   * `409 MULTIPLE_CONNECTIONS` 都是调用方要分别处理的正常状态。
   */
  async getConnection(
    nodeId: string,
    options: { connectionId?: string; cid?: string } = {}
  ): Promise<MeshConnectionResult> {
    const { connectionId, cid } = options;
    const query = cid ? `?cid=${encodeURIComponent(cid)}` : '';
    const res = await this.client.fetch(nodeAuthPath(nodeId, `/api/mesh/connection${query}`), {
      ...(connectionId ? { headers: { [X_TMEX_CONNECTION_HEADER]: connectionId } } : {}),
    });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        code: await readCode(res, 'CONNECTION_LOOKUP_FAILED'),
      };
    }
    const payload = (await res.json()) as Partial<MeshConnectionResponse>;
    if (typeof payload.connectionId !== 'string' || !payload.connectionId) {
      return { ok: false, status: res.status, code: 'MALFORMED' };
    }
    return { ok: true, connectionId: payload.connectionId };
  }

  async challenge(nodeId: string, uid: string): Promise<AuthChallengeResponse> {
    const res = await this.client.fetch(nodeAuthPath(nodeId, '/api/auth/challenge'), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ uid }),
    });
    if (!res.ok) {
      const envelope = await readErrorEnvelope(res, 'Failed to obtain login challenge');
      throw requestError(envelope.code, res.status, envelope.message);
    }
    return (await res.json()) as AuthChallengeResponse;
  }

  /** 登录失败不抛异常：401/429 都带 `{code}`，由调用方按 node 展示。 */
  async login(nodeId: string, body: AuthLoginRequest): Promise<LoginResult> {
    const res = await this.client.fetch(nodeAuthPath(nodeId, '/api/auth/login'), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const fallback = res.status === 429 ? 'RATE_LIMITED' : 'LOGIN_FAILED';
      return { ok: false, status: res.status, code: await readCode(res, fallback) };
    }
    return { ok: true, response: (await res.json()) as AuthLoginResponse };
  }

  async logout(nodeId: string): Promise<void> {
    const res = await this.client.fetch(nodeAuthPath(nodeId, '/api/auth/logout'), {
      method: 'POST',
    });
    if (!res.ok) {
      throw new Error(await parseApiError(res, 'Failed to log out'));
    }
  }

  async passkeyRegisterOptions(): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const res = await this.client.fetch('/api/auth/passkey/register/options', { method: 'POST' });
    if (!res.ok) {
      throw new Error(await parseApiError(res, 'Failed to create passkey registration options'));
    }
    return (await res.json()) as PublicKeyCredentialCreationOptionsJSON;
  }

  /** `challengeId` 来自 register/options 响应里的 `challenge_id`，gateway 用它原子消费挑战。 */
  async passkeyRegisterVerify(
    response: RegistrationResponseJSON,
    challengeId?: string
  ): Promise<PasskeyRegistrationVerified> {
    const res = await this.client.fetch('/api/auth/passkey/register/verify', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ response, challenge_id: challengeId }),
    });
    if (!res.ok) {
      throw new Error(await parseApiError(res, 'Failed to verify passkey registration'));
    }
    return (await res.json()) as PasskeyRegistrationVerified;
  }

  /** `delegation` 为 base64url(borsh(Delegation))：后端据此算 challenge = sha256(borsh)。 */
  async passkeyLoginOptions(
    uid: string,
    delegation: string
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const res = await this.client.fetch('/api/auth/passkey/login/options', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ uid, delegation }),
    });
    if (!res.ok) {
      // 404 `NO_PASSKEY_FOR_ORIGIN`（B2-8）是「本入口没有可用 passkey」这一确定结论，
      // 必须以可判别的类型抛出：调用方据此提示用户，而不是当成未知失败去猜、去回退。
      const envelope = await readErrorEnvelope(res, 'Failed to create passkey login options');
      if (res.status === 404 && envelope.code === 'NO_PASSKEY_FOR_ORIGIN') {
        throw new NoPasskeyForOriginError();
      }
      throw requestError(envelope.code, res.status, envelope.message);
    }
    return (await res.json()) as PublicKeyCredentialRequestOptionsJSON;
  }

  /** `GET /api/auth/passkeys`（需会话）。失败一律抛错，不再静默退化成空列表。 */
  async listPasskeys(): Promise<PasskeySummary[]> {
    const res = await this.client.fetch('/api/auth/passkeys');
    if (!res.ok) {
      throw new Error(await parseApiError(res, 'Failed to load passkeys'));
    }
    const payload = (await res.json()) as { passkeys?: PasskeySummary[] };
    return payload.passkeys ?? [];
  }

  /** `GET /api/auth/keylog/head`（需会话）。构造任何记录都要它给出的 `prev_hash` 与 epoch。 */
  async keyLogHead(): Promise<KeyLogHeadResponse> {
    const res = await this.client.fetch('/api/auth/keylog/head');
    if (!res.ok) {
      throw new Error(await parseApiError(res, 'Failed to load key log head'));
    }
    return (await res.json()) as KeyLogHeadResponse;
  }

  /**
   * `GET /api/auth/totp-record`（需会话）。常规改密重封装 TOTP 用。
   *
   * **只有 404 + `TOTP_NOT_ENABLED` 才是「没开 TOTP」这一确定结论**：401 / 500 / 空体 / HTML
   * 都只说明这次读不到，必须带真实的 code（读不出来就是 `HTTP_<status>`）透出去。把它们
   * 一律当成「没开」，调用方会写出一条 `totp: null` 的 rotate-root-keep 记录，用户既有的
   * TOTP 密文就此永久丢失（见评审 Major）。
   */
  async getTotpRecord(): Promise<
    { ok: true; record: AuthTotpRecordResponse } | { ok: false; status: number; code: string }
  > {
    const res = await this.client.fetch('/api/auth/totp-record');
    if (!res.ok) {
      const code = await readCode(res, '');
      if (res.status === 404 && code === 'TOTP_NOT_ENABLED') {
        return { ok: false, status: 404, code };
      }
      return { ok: false, status: res.status, code: code || `HTTP_${res.status}` };
    }
    const payload = (await res.json()) as Partial<AuthTotpRecordResponse>;
    if (
      (typeof payload.record_seq !== 'string' && typeof payload.record_seq !== 'number') ||
      typeof payload.root_epoch !== 'number' ||
      typeof payload.payload !== 'string'
    ) {
      return { ok: false, status: res.status, code: 'MALFORMED' };
    }
    return {
      ok: true,
      record: {
        record_seq: payload.record_seq,
        root_epoch: payload.root_epoch,
        payload: payload.payload,
      },
    };
  }

  /**
   * 409 `{code:'KEY_LOG_FORK'}` 是业务结果不是异常，必须让 UI 显式报「密钥日志分叉」。
   *
   * `hubSync` → `POST /api/auth/keylog?hub=sync`：entry 先把记录发给 hub 并等 ack 再本地 append，
   * 响应带 `hubAck`。admit / revoke **只有** `hubAck === true` 才能清掉 pending / 认为撤销生效。
   */
  async appendKeyLog(
    body: KeyLogAppendRequest,
    opts: { hubSync?: boolean } = {}
  ): Promise<KeyLogAppendResult> {
    const path = opts.hubSync ? '/api/auth/keylog?hub=sync' : '/api/auth/keylog';
    const res = await this.client.fetch(path, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, code: await readCode(res, 'KEY_LOG_REJECTED') };
    try {
      const payload = (await res.json()) as {
        seq?: number | string;
        hash?: string;
        hubAck?: boolean;
        hubError?: string;
      };
      return {
        ok: true,
        seq: payload.seq,
        hash: payload.hash,
        // 非 hub=sync 模式没有 hubAck 字段，保持 undefined（调用方只在 hubSync 下判定）。
        hubAck: payload.hubAck,
        hubError: payload.hubError,
      };
    } catch {
      return { ok: true };
    }
  }
}

export const defaultAuthApi = new AuthApi();
