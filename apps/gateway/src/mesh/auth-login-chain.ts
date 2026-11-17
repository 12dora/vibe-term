import {
  type Delegation,
  type Login,
  decodeBase64url,
  decodeDelegation,
  decodeLogin,
  verifyLogin,
} from '@vibeterm/shared/auth';
import { requiredStrings } from '../api/route-input';
import type { ChallengeEntry, ChallengeKind, ChallengeStore } from '../auth/challenge-store';
import type { UserRecord } from '../auth/user-store';
import {
  type AuthLoginSecond,
  factorBodyPresent,
  loginBindingError,
  loginFailCodes,
  resolveLoginSecond,
} from './auth-audit-log';
import type { LoginFailureSink } from './auth-key-log-login';
import {
  type PasskeyFactorResult,
  type TotpFactorResult,
  verifySecondFactors,
} from './auth-passkey-origin';
import { waivesPasskeySecondFactor } from './client-source';
import { MESH_VIA_SELF } from './mesh-deps';

export type LoginEnvelope = {
  login: Login;
  sig: Uint8Array;
  delegation: Delegation;
  delegationSig: Uint8Array;
};

export function parseLoginEnvelope(body: Record<string, unknown>): LoginEnvelope | null {
  const fields = requiredStrings(body, ['login', 'sig', 'delegation', 'delegation_sig']);
  if (!fields) return null;
  return {
    login: decodeLogin(decodeBase64url(fields.login)),
    sig: decodeBase64url(fields.sig),
    delegation: decodeDelegation(decodeBase64url(fields.delegation)),
    delegationSig: decodeBase64url(fields.delegation_sig),
  };
}

export type LoginChainHost = {
  nodeId: string;
  nodePk: Uint8Array;
  challengeStore: ChallengeStore;
  now(): number;
  resolveUser(uid: string): UserRecord | null;
  verifyDelegation(
    delegation: Delegation,
    delegationSig: Uint8Array,
    user: UserRecord,
    now: number
  ): Promise<{ ok: true } | { ok: false; code: string; log: string }>;
  checkTotp(
    user: UserRecord,
    method: Delegation['method'],
    totpBody: unknown,
    sessPk: Uint8Array
  ): Promise<TotpFactorResult>;
  checkPasskeySecondFactor(
    req: Request,
    user: UserRecord,
    delegation: Delegation,
    passkeyBody: unknown,
    totpVerified: boolean
  ): Promise<PasskeyFactorResult>;
};

export type LoginChainOk = {
  ok: true;
  envelope: LoginEnvelope;
  challenge: ChallengeEntry;
  user: UserRecord;
  now: number;
  /** 本次请求里 TOTP 是否经过校验（含普通登录的同会话公钥复用）。 */
  totpVerified: boolean;
  second: AuthLoginSecond;
};

export type LoginChainResult = LoginChainOk | { ok: false; res: Response };

/**
 * `/api/auth/login` 与 `/api/auth/login-code` 共用的校验链：challenge 绑定、委托、登录签名、
 * 第二因素。只认 `kind` 种类的 challenge；失败一律经 `sink.fail` 记账。
 * 解码异常不在这里吞掉，由调用方的 try/catch 统一回 MALFORMED。
 */
export async function runLoginChain(
  host: LoginChainHost,
  req: Request,
  body: Record<string, unknown>,
  sink: Pick<LoginFailureSink, 'noteUidHint' | 'fail' | 'rejectUid'>,
  kind: ChallengeKind
): Promise<LoginChainResult> {
  const { fail } = sink;
  const no = (res: Response): LoginChainResult => ({ ok: false, res });
  const envelope = parseLoginEnvelope(body);
  if (!envelope) return no(fail('MALFORMED', 400));
  sink.noteUidHint(envelope.login.uid);
  const uidRejected = sink.rejectUid();
  if (uidRejected) return no(uidRejected);
  const challenge = host.challengeStore.consume(envelope.login.challenge_id);
  if (!challenge || challenge.kind !== kind) return no(fail('CHALLENGE_CONSUMED'));
  const bound = loginBindingError(
    envelope.login,
    challenge,
    host.nodeId,
    host.nodePk,
    envelope.delegation.uid,
    MESH_VIA_SELF
  );
  if (bound) return no(fail(bound));
  const user = host.resolveUser(envelope.login.uid);
  if (!user) return no(fail('INVALID_CREDENTIALS', 401, 'UNKNOWN_USER'));
  const now = host.now();
  const delOk = await host.verifyDelegation(envelope.delegation, envelope.delegationSig, user, now);
  if (!delOk.ok) return no(fail(delOk.code, 401, delOk.log));
  const loginOk = verifyLogin(envelope.login, envelope.sig, envelope.delegation.sess_pk, {
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    target: envelope.login.target,
    targetPk: host.nodePk,
    uid: challenge.uid,
    entry: envelope.login.entry,
  });
  if (!loginOk.ok) {
    const { client, log } = loginFailCodes(loginOk.error);
    return no(fail(client, 401, log));
  }
  let totpVerified = false;
  const second = await verifySecondFactors({
    checkTotp: async (u, method, totp, sessPk) => {
      const result = await host.checkTotp(u, method, totp, sessPk);
      totpVerified = result.ok && result.verified;
      return result;
    },
    checkPasskeySecondFactor: (r, u, delegation, passkey, verified) =>
      host.checkPasskeySecondFactor(r, u, delegation, passkey, verified),
    req,
    user,
    delegation: envelope.delegation,
    body,
  });
  if (!second.ok) return no(fail(second.code));
  return {
    ok: true,
    envelope,
    challenge,
    user,
    now,
    totpVerified,
    second: resolveLoginSecond({
      method: envelope.delegation.method,
      totpPresent: factorBodyPresent(body.totp, 'code'),
      passkeyPresent: factorBodyPresent(body.passkey, 'sig'),
      waived: waivesPasskeySecondFactor(req),
    }),
  };
}
