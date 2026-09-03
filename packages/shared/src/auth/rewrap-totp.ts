import type { RotateRootKeepTotp, SetTotpPayload } from './encoding';
import { deriveTotpKey } from './totp';
import { decryptTotpSecret, encryptTotpSecret } from './totp-cipher';

export interface RewrapTotpInput {
  uid: string;
  oldSeed: Uint8Array;
  newSeed: Uint8Array;
  rootEpoch: number;
  totpRecordSeq: bigint | number;
  totp: SetTotpPayload;
  nextSeq: bigint;
}

/**
 * 把现有 TOTP 密文从旧 seed / 旧 epoch 换封到新 seed / 新 epoch。
 *
 * 解密用 `k_old = HKDF(oldSeed, epoch=E)` + AAD `{uid, E, totpRecordSeq}`；
 * 重加密用 `k_new = HKDF(newSeed, epoch=E+1)` + AAD `{uid, E+1, nextSeq}`。
 */
export async function rewrapTotpSecret(input: RewrapTotpInput): Promise<RotateRootKeepTotp> {
  const nextEpoch = input.rootEpoch + 1;
  const kOld = deriveTotpKey(input.oldSeed, input.uid, input.rootEpoch);
  const kNew = deriveTotpKey(input.newSeed, input.uid, nextEpoch);
  let secret: Uint8Array | null = null;
  try {
    secret = await decryptTotpSecret(kOld, input.totp, {
      uid: input.uid,
      root_epoch: input.rootEpoch,
      seq: BigInt(input.totpRecordSeq),
    });
    const payload = await encryptTotpSecret(kNew, secret, {
      uid: input.uid,
      root_epoch: nextEpoch,
      seq: input.nextSeq,
    });
    return { root_epoch: nextEpoch, seq: input.nextSeq, payload };
  } finally {
    secret?.fill(0);
    kOld.fill(0);
    kNew.fill(0);
  }
}
