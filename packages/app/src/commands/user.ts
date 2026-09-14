import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import { kdfParamsFromJson } from '../../../../apps/gateway/src/auth/user-key-service';
import {
  deriveTotpKey,
  encodeSetTotpPayload,
  encryptTotpSecret,
  randomBytes,
} from '../../../shared/src/auth';
import { assertRootKeyMatches, deriveRootKey, resolvePassword } from '../lib/password';
import { fingerprintPublicKey, totpOtpauthUri } from '../lib/totp-uri';
import { applyUserPasswd } from '../lib/user-passwd';
import type { ParsedArgs } from '../types';
import type { CliIo } from './cli-io';
import { withAuth } from './with-auth';

function log(io: CliIo | undefined, message: string): void {
  (io?.log ?? console.log)(message);
}

function nowMs(io?: CliIo): number {
  return io?.now?.() ?? Date.now();
}

export async function runUserAdd(
  parsed: ParsedArgs,
  username: string,
  io: CliIo = {}
): Promise<{ userId: string; fingerprint: string; rootEpoch: number }> {
  if (!username) {
    throw new Error('user add requires <username>');
  }
  const password = await resolvePassword({
    password: io.password,
    confirm: io.password === undefined,
    prompt: 'New password',
    confirmPrompt: 'Confirm password',
  });
  return await withAuth(parsed, io, async (ctx) => {
    if (ctx.userStore.getByUsername(username)) {
      throw new Error(`user already exists: ${username} (use mesh reset-root to replace the root)`);
    }
    const identity = await ensureNodeIdentity(ctx.identityStore);
    const boot = await ctx.userKeys.bootstrapUserWithSelfAdmit({
      username,
      password,
      identity,
      now: nowMs(io),
    });
    const fingerprint = fingerprintPublicKey(boot.rootPublicKey);
    log(io, `user ${username} created`);
    log(io, `root public key fingerprint: ${fingerprint}`);
    return { userId: boot.userId, fingerprint, rootEpoch: boot.rootEpoch };
  });
}

export async function runUserPasswd(
  parsed: ParsedArgs,
  username: string,
  io: CliIo = {}
): Promise<{ rootEpoch: number; mode: 'keep' | 'full-reset' }> {
  if (!username) {
    throw new Error('user passwd requires <username>');
  }
  return await withAuth(parsed, io, (ctx) => applyUserPasswd(parsed, username, ctx, io));
}

export async function runUserTotp(
  parsed: ParsedArgs,
  username: string,
  io: CliIo = {}
): Promise<{ uri: string; secret: Uint8Array }> {
  if (!username) {
    throw new Error('user totp requires <username>');
  }
  const password = await resolvePassword({
    password: io.password,
    confirm: false,
    prompt: 'Password',
  });
  return await withAuth(parsed, io, async (ctx) => {
    const user = ctx.userStore.getByUsername(username);
    if (!user) {
      throw new Error(`user not found: ${username}`);
    }
    const rootKey = await deriveRootKey(password, kdfParamsFromJson(user.kdfParamsJson));
    assertRootKeyMatches(rootKey, user.rootPublicKey);
    const secret = randomBytes(20);
    const seq = BigInt(user.keyLogHeadSeq + 1);
    const kTotp = deriveTotpKey(rootKey.seed, user.id, user.rootEpoch);
    const payload = await encryptTotpSecret(kTotp, secret, {
      uid: user.id,
      root_epoch: user.rootEpoch,
      seq,
    });
    const applied = await ctx.userKeys.signAndApply(user.id, rootKey, {
      type: 'set-totp',
      payload: encodeSetTotpPayload(payload),
    });
    if (!applied.ok) {
      throw new Error(`set-totp failed: ${applied.error}`);
    }
    const uri = totpOtpauthUri(username, secret);
    log(io, `TOTP enrolled for ${username}`);
    log(io, uri);
    return { uri, secret };
  });
}
