import { kdfParamsFromJson } from '../../../../apps/gateway/src/auth/user-key-service';
import {
  type RotateRootKeepTotp,
  type SetTotpPayload,
  decryptTotpSecret,
  deriveTotpKey,
  encodeRotateRootKeepPayload,
  encodeRotateRootPayload,
  encryptTotpSecret,
  generateKdfParams,
} from '../../../shared/src/auth';
import { t } from '../i18n';
import type { ParsedArgs } from '../types';
import type { LocalAuthContext } from './local-auth';
import { assertRootKeyMatches, deriveRootKey, resolvePassword } from './password';

export type PasswdMode = 'keep' | 'full-reset';

const HUB_TIMEOUT = 'HUB_TIMEOUT';
const HUB_NOT_WRITER = 'HUB_NOT_WRITER';
const KEYLOG_TYPE_UNSUPPORTED_BY_NODES = 'KEYLOG_TYPE_UNSUPPORTED_BY_NODES';

export function mapPasswdApplyError(error: string): string {
  if (error === HUB_TIMEOUT) return t('hub.user.passwd.hubTimeout');
  if (error === HUB_NOT_WRITER) return t('hub.user.passwd.hubNotWriter');
  if (error === KEYLOG_TYPE_UNSUPPORTED_BY_NODES) return t('hub.user.passwd.nodesTooOld');
  return t('hub.user.passwd.failed', { error });
}

export function isPasswdFullReset(parsed: ParsedArgs): boolean {
  return parsed.flags['full-reset'] === true;
}

async function rewrapTotpForKeep(input: {
  uid: string;
  totpRecordSeq: number | null;
  totp: SetTotpPayload | null;
  oldSeed: Uint8Array;
  newSeed: Uint8Array;
  rootEpoch: number;
  nextSeq: bigint;
}): Promise<RotateRootKeepTotp | null> {
  if (input.totpRecordSeq == null || !input.totp) return null;
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

function buildPasswdRecord(input: {
  fullReset: boolean;
  publicKey: Uint8Array;
  kdfParams: ReturnType<typeof generateKdfParams>;
  totp: RotateRootKeepTotp | null;
}): { type: 'rotate-root' | 'rotate-root-keep'; payload: Uint8Array } {
  if (input.fullReset) {
    return {
      type: 'rotate-root',
      payload: encodeRotateRootPayload({
        root_public_key: input.publicKey,
        kdf_params: input.kdfParams,
      }),
    };
  }
  return {
    type: 'rotate-root-keep',
    payload: encodeRotateRootKeepPayload({
      root_public_key: input.publicKey,
      kdf_params: input.kdfParams,
      totp: input.totp,
    }),
  };
}

export async function applyHubUserPasswd(
  parsed: ParsedArgs,
  username: string,
  ctx: LocalAuthContext,
  io: {
    log?: (message: string) => void;
    password?: string;
    oldPassword?: string;
    newPassword?: string;
  }
): Promise<{ rootEpoch: number; mode: PasswdMode }> {
  const user = ctx.userStore.getByUsername(username);
  if (!user) {
    throw new Error(`user not found: ${username}`);
  }
  const oldPassword = await resolvePassword({
    password: io.oldPassword,
    envKey: 'TMEX_PASSWORD_OLD',
    confirm: false,
    prompt: 'Current password',
  });
  const oldKey = await deriveRootKey(oldPassword, kdfParamsFromJson(user.kdfParamsJson));
  assertRootKeyMatches(oldKey, user.rootPublicKey);

  const newPassword = await resolvePassword({
    password: io.newPassword ?? io.password,
    envKey: 'TMEX_PASSWORD',
    confirm: io.newPassword === undefined && io.password === undefined,
    prompt: 'New password',
    confirmPrompt: 'Confirm new password',
  });
  const kdfParams = generateKdfParams();
  const newKey = await deriveRootKey(newPassword, kdfParams);
  const fullReset = isPasswdFullReset(parsed);
  const mode: PasswdMode = fullReset ? 'full-reset' : 'keep';
  try {
    const totp = fullReset
      ? null
      : await rewrapTotpForKeep({
          uid: user.id,
          totpRecordSeq: user.totpRecordSeq,
          totp: ctx.userKeys.currentState(user.id).totp,
          oldSeed: oldKey.seed,
          newSeed: newKey.seed,
          rootEpoch: user.rootEpoch,
          nextSeq: BigInt(user.keyLogHeadSeq + 1),
        });
    const record = buildPasswdRecord({
      fullReset,
      publicKey: newKey.publicKey,
      kdfParams,
      totp,
    });
    const applied = await ctx.userKeys.signAndApply(user.id, oldKey, record);
    if (!applied.ok) {
      throw new Error(mapPasswdApplyError(applied.error));
    }
  } finally {
    oldKey.seed.fill(0);
    newKey.seed.fill(0);
  }
  const next = ctx.userStore.getById(user.id);
  const doneKey = fullReset ? 'hub.user.passwd.doneFullReset' : 'hub.user.passwd.doneKeep';
  (io.log ?? console.log)(t(doneKey, { username }));
  return { rootEpoch: next?.rootEpoch ?? user.rootEpoch + 1, mode };
}
