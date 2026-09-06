import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import { kdfParamsFromJson } from '../../../../apps/gateway/src/auth/user-key-service';
import { encodeBase64url, encodeRemovePasskeyPayload } from '../../../shared/src/auth';
import { t } from '../i18n';
import { assertRootKeyMatches, deriveRootKey, resolvePassword } from '../lib/password';
import { isStandaloneRoles, parseVibeTermRoles } from '../lib/roles';
import { fingerprintPublicKey } from '../lib/totp-uri';
import type { ParsedArgs } from '../types';
import type { HubIo } from './hub';
import { withAuth } from './with-auth';

function log(io: HubIo | undefined, message: string): void {
  (io?.log ?? console.log)(message);
}

export async function runMeshResetRoot(
  parsed: ParsedArgs,
  io: HubIo = {}
): Promise<{ userId: string; rootEpoch: number; fingerprint: string }> {
  const roles = parseVibeTermRoles(io.auth?.env.VIBETERM_ROLES ?? process.env.VIBETERM_ROLES);
  if (isStandaloneRoles(roles)) {
    throw new Error('mesh reset-root is refused when VIBETERM_ROLES is standalone');
  }

  const password = await resolvePassword({
    password: io.password,
    confirm: io.password === undefined,
    prompt: 'New password',
    confirmPrompt: 'Confirm new password',
  });

  return await withAuth(parsed, io, async (ctx) => {
    const existing = ctx.db
      .select()
      .from((await import('../../../../apps/gateway/src/db/schema')).users)
      .all();
    const first = existing[0];
    if (!first) {
      throw new Error('no local user to reset; run hub user add first');
    }
    const username = first.username;
    const identity = await ensureNodeIdentity(ctx.identityStore);
    const boot = await ctx.userKeys.bootstrapUserWithSelfAdmit({
      username,
      password,
      identity,
      now: io.now?.() ?? Date.now(),
    });
    const fingerprint = fingerprintPublicKey(boot.rootPublicKey);
    log(io, `root reset for ${username}; re-enroll other machines`);
    log(io, `root public key fingerprint: ${fingerprint}`);
    return { userId: boot.userId, rootEpoch: boot.rootEpoch, fingerprint };
  });
}

/**
 * 删掉账户名下**全部**通行密钥，保留 TOTP 与已有会话。
 *
 * 逃生舱：二次验证按 origin 生效（见 docs/auth/2026090701-passkey-per-origin.md），认证器丢了
 * 之后，注册过通行密钥的那个地址就再也登不进去。这条命令只签 `remove-passkey`，不动根钥，
 * 不比 `hub user passwd --full-reset` 多撤销任何东西。
 */
export async function runMeshPasskeyRemoveAll(
  parsed: ParsedArgs,
  username: string,
  io: HubIo = {}
): Promise<{ userId: string; removed: number }> {
  const password = await resolvePassword({
    password: io.password,
    confirm: false,
    prompt: 'Password',
  });

  return await withAuth(parsed, io, async (ctx) => {
    const user = username ? ctx.userStore.getByUsername(username) : ctx.userStore.listUsers()[0];
    if (!user) {
      throw new Error(username ? `unknown user: ${username}` : 'no local user');
    }
    const rootKey = await deriveRootKey(password, kdfParamsFromJson(user.kdfParamsJson));
    assertRootKeyMatches(rootKey, user.rootPublicKey);

    const keys = ctx.userStore.listKeysByUser(user.id);
    for (const key of keys) {
      const applied = await ctx.userKeys.signAndApply(user.id, rootKey, {
        type: 'remove-passkey',
        payload: encodeRemovePasskeyPayload({
          credential_id: encodeBase64url(key.credentialId),
        }),
      });
      if (!applied.ok) {
        throw new Error(`remove-passkey failed: ${applied.error}`);
      }
    }
    log(io, t('mesh.passkey.removed', { count: keys.length, username: user.username }));
    return { userId: user.id, removed: keys.length };
  });
}
