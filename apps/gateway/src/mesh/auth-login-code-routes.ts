import {
  LOGIN_CODE_ERRORS,
  LOGIN_CODE_PATH,
  LOGIN_CODE_REDEEM_PATH,
  LOGIN_CODE_REVOKE_PATH,
  LOGIN_CODE_STATUS_PATH,
  type LoginCodeStatusResponse,
} from '@vibeterm/shared';
import {
  type Delegation,
  type KeyLogEffect,
  LOGIN_CODE_FRESH_DELEGATION_MS,
  LOGIN_CODE_NODE_CODE_BYTES,
  decodeBase64url,
  encodeBase64url,
  loginCodeHashHex,
  nodeIdToHex,
} from '@vibeterm/shared/auth';
import { readJsonObjectBody } from '../api/http';
import { type LoginCodeGrant, LoginCodeStore } from '../auth/login-code-store';
import { noteAuthLoginFailure, recordAuthLoginSuccess } from '../auth/login-records-hooks';
import { popLoginAllowed } from '../auth/session-pop';
import type { UserStore } from '../auth/user-store';
import { logAuthLoginCodeIssued, logAuthLoginFailed, logAuthLoginOk } from './auth-audit-log';
import { type LoginFailureSink, loginRequestContext } from './auth-key-log-login';
import { type LoginChainHost, runLoginChain } from './auth-login-chain';
import { MESH_VIA_SELF, getMeshRequestContext } from './mesh-deps';
import { jsonBody, jsonError } from './session-middleware';

export const LOGIN_CODE_ROUTE_PATHS = [
  LOGIN_CODE_PATH,
  LOGIN_CODE_REDEEM_PATH,
  LOGIN_CODE_STATUS_PATH,
  LOGIN_CODE_REVOKE_PATH,
] as const;

const SESS_PK_BYTES = 32;
const CODE_HASH_BYTES = 32;
const B64URL = /^[A-Za-z0-9_-]+$/;

export type SessionDelegation = {
  method: Delegation['method'];
  sess_pk: Uint8Array;
  credential_id: string | null | undefined;
};

export type IssueSessionInput = {
  userId: string;
  viaNodeId: string;
  delegation: SessionDelegation;
  now: number;
  popRequired: boolean;
  fail: (code: string, status?: number) => Response;
  /** 合并进响应体的额外字段。 */
  extra?: Record<string, unknown>;
};

export type LoginCodeRoutesHost = {
  userStore: UserStore;
  now(): number;
  openSink(req: Request, ctx: { peer: boolean; ip: string }): LoginFailureSink;
  /** 签发用的校验链：TOTP 走严格防重放。 */
  issueChainHost: LoginChainHost;
  consumeChallengeQuota(req: Request): Response | null;
  recordLoginSuccess(req: Request): void;
  issueSession(input: IssueSessionInput): Response;
  origin(req: Request): string;
};

export class LoginCodeRoutes {
  readonly store: LoginCodeStore;

  constructor(private readonly host: LoginCodeRoutesHost) {
    this.store = new LoginCodeStore({ now: () => host.now() });
  }

  route(req: Request, path: string): Promise<Response> | null {
    if (req.method !== 'POST') return null;
    if (path === LOGIN_CODE_PATH) return this.handleIssue(req);
    if (path === LOGIN_CODE_REDEEM_PATH) return this.handleRedeem(req);
    if (path === LOGIN_CODE_STATUS_PATH) return this.handleLookup(req, 'status');
    if (path === LOGIN_CODE_REVOKE_PATH) return this.handleLookup(req, 'revoke');
    return null;
  }

  private async handleIssue(req: Request): Promise<Response> {
    const ctx = loginRequestContext(req);
    const sink = this.host.openSink(req, ctx);
    const body = await readJsonObjectBody(req);
    const blocked = sink.precheck(body);
    if (blocked) return blocked;
    try {
      const rec = body as Record<string, unknown>;
      const codeHash = decodeFixedB64url(rec.code_hash, CODE_HASH_BYTES);
      if (!codeHash) return sink.fail('MALFORMED', 400);
      const chain = await runLoginChain(this.host.issueChainHost, req, rec, sink, 'login-code');
      if (!chain.ok) return chain.res;
      const { delegation } = chain.envelope;
      const freshSince = BigInt(chain.now - LOGIN_CODE_FRESH_DELEGATION_MS);
      if (!chain.totpVerified && delegation.issued_at < freshSince) {
        return sink.fail(LOGIN_CODE_ERRORS.stepUpRequired);
      }
      const created = this.store.create({
        hashHex: Buffer.from(codeHash).toString('hex'),
        uid: chain.user.id,
        method: delegation.method,
        credentialId: delegation.method === 'passkey' ? (delegation.credential_id ?? null) : null,
        second: chain.second,
        createdVia: chain.challenge.entryNodeId,
      });
      if (!created.ok) {
        return created.reason === 'duplicate'
          ? jsonError('MALFORMED', 400)
          : jsonError(LOGIN_CODE_ERRORS.limit, 409);
      }
      this.host.recordLoginSuccess(req);
      logAuthLoginCodeIssued({
        uid: chain.user.id,
        via: chain.challenge.entryNodeId,
        method: delegation.method,
        second: chain.second,
        ip: ctx.ip,
      });
      return jsonBody({ expires_at: created.grant.expiresAt }, 201);
    } catch {
      return sink.fail('MALFORMED', 400);
    }
  }

  private async handleRedeem(req: Request): Promise<Response> {
    const body = await readJsonObjectBody(req);
    const code = decodeFixedB64url(body?.code, LOGIN_CODE_NODE_CODE_BYTES);
    const sessPk = decodeFixedB64url(body?.sess_pk, SESS_PK_BYTES);
    if (!body || !code || !sessPk) return jsonError('MALFORMED', 400);
    const limited = this.host.consumeChallengeQuota(req);
    if (limited) return limited;
    const hashHex = loginCodeHashHex(code);
    const peek = this.store.get(hashHex);
    if (!peek) return this.redeemFail(req, '', LOGIN_CODE_ERRORS.invalid);
    const user = this.host.userStore.getById(peek.uid);
    if (!user) return this.redeemFail(req, peek.uid, LOGIN_CODE_ERRORS.invalid);
    const consumed = this.store.consume(hashHex);
    if (!consumed.ok) return this.redeemFail(req, peek.uid, consumed.code);
    const grant = consumed.grant;
    const via = getMeshRequestContext(req).via || MESH_VIA_SELF;
    const issued = this.host.issueSession({
      userId: user.id,
      viaNodeId: via,
      delegation: { method: grant.method, sess_pk: sessPk, credential_id: grant.credentialId },
      now: this.host.now(),
      popRequired: popLoginAllowed(req, via, body.pop),
      fail: (failCode, status) => this.redeemFail(req, user.id, failCode, status),
      extra: { uid: user.id, username: user.username || null },
    });
    if (issued.status === 200) this.recordRedeemed(req, grant, via);
    return issued;
  }

  private async handleLookup(req: Request, action: 'status' | 'revoke'): Promise<Response> {
    const body = await readJsonObjectBody(req);
    const code = decodeFixedB64url(body?.code, LOGIN_CODE_NODE_CODE_BYTES);
    if (!code) return jsonError('MALFORMED', 400);
    const limited = this.host.consumeChallengeQuota(req);
    if (limited) return limited;
    const hashHex = loginCodeHashHex(code);
    const grant = action === 'status' ? this.store.get(hashHex) : this.store.revoke(hashHex);
    if (!grant) return jsonError(LOGIN_CODE_ERRORS.invalid, 404);
    const payload: LoginCodeStatusResponse = {
      state: grant.state,
      expires_at: grant.expiresAt,
      used_at: grant.usedAt,
    };
    return jsonBody(payload);
  }

  /** 改密 / 轮换根密钥 / 重置、撤销节点、删除通行密钥：作废相关的待兑换码。 */
  applyKeyLogEffects(userId: string, effects: readonly KeyLogEffect[]): void {
    for (const effect of effects) {
      if (effect.type === 'revokeAllSessions') {
        this.store.revokeWhere((grant) => grant.uid === userId);
      } else if (effect.type === 'revokeSessionsVia') {
        const via = nodeIdToHex(effect.nodeId);
        this.store.revokeWhere((grant) => grant.createdVia === via);
      } else if (effect.type === 'revokeSessionsByCredential') {
        const target = normalizeCredentialId(effect.credentialId);
        this.store.revokeWhere(
          (grant) =>
            grant.credentialId !== null && normalizeCredentialId(grant.credentialId) === target
        );
      }
    }
  }

  revokeForUser(userId: string): void {
    this.store.revokeWhere((grant) => grant.uid === userId);
  }

  private recordRedeemed(req: Request, grant: LoginCodeGrant, via: string): void {
    const origin = this.host.origin(req);
    logAuthLoginOk({
      uid: grant.uid,
      via,
      method: grant.method,
      second: 'code',
      ip: loginRequestContext(req).ip,
      origin,
    });
    recordAuthLoginSuccess({
      uid: grant.uid,
      via,
      method: grant.method,
      second: 'code',
      origin,
      req,
    });
  }

  private redeemFail(req: Request, uid: string, code: string, status = 401): Response {
    const { ip } = loginRequestContext(req);
    logAuthLoginFailed({ uid, code, ip });
    noteAuthLoginFailure({ uid, code, status, ip, req, method: null });
    return jsonError(code, status);
  }
}

function decodeFixedB64url(value: unknown, length: number): Uint8Array | null {
  if (typeof value !== 'string' || !B64URL.test(value)) return null;
  try {
    const bytes = decodeBase64url(value);
    return bytes.length === length ? bytes : null;
  } catch {
    return null;
  }
}

function normalizeCredentialId(id: string): string {
  try {
    return encodeBase64url(decodeBase64url(id));
  } catch {
    return encodeBase64url(new TextEncoder().encode(id));
  }
}
