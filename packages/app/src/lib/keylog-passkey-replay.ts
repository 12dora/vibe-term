import {
  decodePasskeyAssertionSig,
  verifyAssertion,
} from '../../../../apps/gateway/src/auth/passkey';
import { UserKeyService } from '../../../../apps/gateway/src/auth/user-key-service';
import type { AddPasskeyPayload, VerifyPasskeyAssertion } from '../../../shared/src/auth';
import {
  bytesEqual,
  decodeAddPasskeyPayload,
  decodeKeyLogRecord,
  encodeBase64url,
} from '../../../shared/src/auth';
import type { LocalAuthContext } from './local-auth';

/**
 * 加入时回放的密钥日志里可能有 passkey 签名的记录（吊销、`meta-key`、`set-relays`…），
 * 而本机此刻还没有这个用户，`UserStore` 里一条凭据都没有——用 `makeVerifyPasskeyAssertion`
 * 那种「查本地库」的验签器一律得到 `unknown_signer`，整条链会被拒。
 *
 * 但验签需要的东西链里全有：`add-passkey` 记录的 payload 带 `origin` / `rp_id` / `counter` /
 * `transports`，公钥由 `verifyKeyLogChain` 从投影状态里取好后传进来。这里就用链自身当凭据表。
 *
 * 计数器按验签结果单调推进（等价 `updateKeyCounter`），同一凭据的重放会被拒。
 */
export function makeReplayPasskeyVerifier(
  records: readonly { bytes: Uint8Array }[]
): VerifyPasskeyAssertion {
  const registrations: AddPasskeyPayload[] = [];
  for (const item of records) {
    try {
      const record = decodeKeyLogRecord(item.bytes);
      if (record.type !== 'add-passkey') continue;
      registrations.push(decodeAddPasskeyPayload(record.payload));
    } catch {
      // 畸形记录由链验证自己拒绝，这里只管收集能读懂的凭据。
    }
  }
  const counters = new Map<string, number>();

  return async ({ sig, credentialId, publicKey, challenge }) => {
    const matches = registrations.filter((item) => item.credential_id === credentialId);
    // 同一 credential_id 被重新登记过时，按公钥挑出投影状态当前认的那一条。
    const registration =
      matches.filter((item) => bytesEqual(item.public_key, publicKey)).at(-1) ?? matches.at(-1);
    if (!registration) return false;
    let assertion: ReturnType<typeof decodePasskeyAssertionSig>;
    try {
      assertion = decodePasskeyAssertionSig(sig);
    } catch {
      return false;
    }
    const counter = counters.get(credentialId) ?? registration.counter;
    const result = await verifyAssertion({
      response: assertion,
      expectedChallenge: encodeBase64url(challenge),
      origin: registration.origin,
      rpId: registration.rp_id,
      credential: {
        id: credentialId,
        publicKey,
        counter,
        transports: registration.transports,
      },
    });
    if (!result.ok) return false;
    counters.set(credentialId, result.newCounter);
    return true;
  };
}

/**
 * `commitJoin` 内部回放同一条链，也需要上面的验签器；`LocalAuthContext.userKeys` 是按「本机已有
 * 用户」建的（无验签器），所以加入时另起一个只服务这次提交的实例。
 */
export function joinUserKeyService(
  ctx: LocalAuthContext,
  records: readonly { bytes: Uint8Array }[]
): UserKeyService {
  return new UserKeyService({
    db: ctx.db,
    userStore: ctx.userStore,
    keyLogStore: ctx.keyLogStore,
    nodeSessionStore: ctx.nodeSessionStore,
    verifyPasskeyAssertion: makeReplayPasskeyVerifier(records),
  });
}
