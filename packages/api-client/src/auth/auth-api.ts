// mesh 鉴权 REST 客户端。所有 `/n/:T/...` 路径由 nodeId 决定，`self` 退化为不带前缀的旧路由。

import { type ApiClient, defaultApiClient, parseApiError } from '../client';
import type {
  AuthChallengeResponse,
  AuthLoginErrorCode,
  AuthLoginRequest,
  AuthLoginResponse,
  AuthModeResponse,
  KeyLogAppendRequest,
  KeyLogAppendResult,
  KeyLogHeadResponse,
  MeshNode,
  MeshNodesResponse,
  PasskeyRegistrationVerified,
  PasskeySummary,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from './types';

/** entry 自身的 nodeId 占位符（与后端路由 `/n/:nodeId` 的 self 语义一致）。 */
export const SELF_NODE_ID = 'self';

/** `self` → 原路径；其余 → `/n/<id>` 前缀。与 F4-2 的 `node-url.ts` 语义一致。 */
export function nodeAuthPath(nodeId: string, path: string): string {
  return nodeId === SELF_NODE_ID ? path : `/n/${encodeURIComponent(nodeId)}${path}`;
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

  async listNodes(): Promise<MeshNode[]> {
    const res = await this.client.fetch('/api/mesh/nodes');
    if (!res.ok) {
      throw new Error(await parseApiError(res, 'Failed to load mesh nodes'));
    }
    const payload = (await res.json()) as MeshNodesResponse;
    return payload.nodes ?? [];
  }

  async challenge(nodeId: string, uid: string): Promise<AuthChallengeResponse> {
    const res = await this.client.fetch(nodeAuthPath(nodeId, '/api/auth/challenge'), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ uid }),
    });
    if (!res.ok) {
      throw new Error(await parseApiError(res, 'Failed to obtain login challenge'));
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
      throw new Error(await parseApiError(res, 'Failed to create passkey login options'));
    }
    return (await res.json()) as PublicKeyCredentialRequestOptionsJSON;
  }

  /** 端点尚未上线时（404）返回空列表，账号安全页只显示「添加」。 */
  async listPasskeys(): Promise<PasskeySummary[]> {
    const res = await this.client.fetch('/api/auth/passkeys');
    if (res.status === 404) return [];
    if (!res.ok) {
      throw new Error(await parseApiError(res, 'Failed to load passkeys'));
    }
    const payload = (await res.json()) as { passkeys?: PasskeySummary[] };
    return payload.passkeys ?? [];
  }

  async keyLogHead(): Promise<KeyLogHeadResponse> {
    const res = await this.client.fetch('/api/auth/keylog/head');
    if (!res.ok) {
      throw new Error(await parseApiError(res, 'Failed to load key log head'));
    }
    return (await res.json()) as KeyLogHeadResponse;
  }

  /** 409 `{code:'KEY_LOG_FORK'}` 是业务结果不是异常，必须让 UI 显式报「密钥日志分叉」。 */
  async appendKeyLog(body: KeyLogAppendRequest): Promise<KeyLogAppendResult> {
    const res = await this.client.fetch('/api/auth/keylog', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true };
    return { ok: false, code: await readCode(res, 'KEY_LOG_REJECTED') };
  }
}

export const defaultAuthApi = new AuthApi();
