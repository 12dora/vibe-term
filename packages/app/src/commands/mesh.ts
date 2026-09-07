import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import { kdfParamsFromJson } from '../../../../apps/gateway/src/auth/user-key-service';
import { encodeBase64url, encodeRemovePasskeyPayload } from '../../../shared/src/auth';
import { t } from '../i18n';
import type { FetchLike } from '../lib/fetch-like';
import { confirmDestructiveReset } from '../lib/hub-user-passwd';
import { assertRootKeyMatches, deriveRootKey, resolvePassword } from '../lib/password';
import { isStandaloneRoles, parseVibeTermRoles } from '../lib/roles';
import { fingerprintPublicKey } from '../lib/totp-uri';
import { resetTlsConfig } from '../tls/tls-recovery';
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

  await confirmDestructiveReset(parsed, io);
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
 * 逃生舱：二次验证按 origin 生效（见 docs/security/login-security.md），认证器丢了
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

export async function runMeshResetIdentity(
  parsed: ParsedArgs,
  io: HubIo = {}
): Promise<{ nodeId: string }> {
  const resetTls = parsed.flags['reset-tls'] === true;
  const warning = [t('mesh.identity.warning'), ...(resetTls ? [t('tls.reset.warning')] : [])];
  await confirmDestructiveReset(parsed, io, warning.join('\n'));
  return await withAuth(parsed, io, async (ctx) => {
    const { nodeIdentity, meshRelays, meshSecrets, peerCache, meshHubs, nodeSessions } =
      await import('../../../../apps/gateway/src/db/schema');
    // 先完成新密钥的加密，再原子替换旧身份，避免主密钥本身无效时丢失旧记录。
    const { generateEd25519KeyPair, generateX25519KeyPair, randomBytes, nodeIdToHex } =
      await import('../../../shared/src/auth');
    const { encrypt } = await import('../../../../apps/gateway/src/crypto');
    const ed = generateEd25519KeyPair();
    const x = generateX25519KeyPair();
    const nodeId = nodeIdToHex(randomBytes(16));
    try {
      const privateKey = await encrypt(Buffer.from(ed.secretKey).toString('base64'));
      const x25519PrivateKey = await encrypt(Buffer.from(x.secretKey).toString('base64'));
      ctx.db.transaction((tx) => {
        tx.delete(nodeIdentity).run();
        tx.insert(nodeIdentity)
          .values({
            id: 1,
            nodeId,
            privateKey,
            x25519PrivateKey,
            certificateJson: JSON.stringify({ x25519PublicKey: encodeBase64url(x.publicKey) }),
            certSig: Buffer.alloc(0),
            userId: null,
            hubUrl: null,
          })
          .run();
        tx.delete(meshRelays).run();
        tx.delete(meshSecrets).run();
        tx.delete(peerCache).run();
        tx.delete(meshHubs).run();
        tx.delete(nodeSessions).run();
        if (resetTls) resetTlsConfig(tx);
      });
      if (resetTls) log(io, t('tls.reset.done'));
      log(io, t('mesh.identity.done', { nodeId }));
      return { nodeId };
    } finally {
      ed.secretKey.fill(0);
      x.secretKey.fill(0);
    }
  });
}

export type MeshKeyLogStatus = {
  userId: string | null;
  local: { seq: number; hash: string } | null;
  remote: { seq: number; hash: string } | null;
  remoteKind: 'hub' | 'relay' | null;
  localAtRemote: string | null;
  remoteAtLocal: string | null;
  error?: string;
};

export function keyLogStatusVerdict(
  status: MeshKeyLogStatus
): 'FORK' | 'BEHIND' | 'AHEAD' | 'IN_SYNC' | 'UNKNOWN' {
  const { local, remote } = status;
  if (!local || !remote) return 'UNKNOWN';
  if (local.seq === remote.seq) return local.hash === remote.hash ? 'IN_SYNC' : 'FORK';
  if (local.seq < remote.seq) {
    if (!status.remoteAtLocal) return 'UNKNOWN';
    return status.remoteAtLocal === local.hash ? 'BEHIND' : 'FORK';
  }
  if (!status.localAtRemote) return 'UNKNOWN';
  return status.localAtRemote === remote.hash ? 'AHEAD' : 'FORK';
}

export async function runMeshKeylogStatus(
  parsed: ParsedArgs,
  io: HubIo & { fetcher?: FetchLike; setExitCode?: (code: number) => void } = {}
): Promise<MeshKeyLogStatus & { verdict: ReturnType<typeof keyLogStatusVerdict> }> {
  return await withAuth(parsed, io, async (ctx) => {
    const user = ctx.userStore.listUsers()[0];
    const head = user ? ctx.keyLogStore.head(user.id) : null;
    let status: MeshKeyLogStatus = {
      userId: user?.id ?? null,
      local: head ? { seq: Number(head.seq), hash: encodeBase64url(head.hash) } : null,
      remote: null,
      remoteKind: null,
      localAtRemote: null,
      remoteAtLocal: null,
      error: 'runtime_unavailable',
    };
    const port = Number(ctx.env.GATEWAY_PORT || 9883);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('invalid GATEWAY_PORT');
    try {
      const response = await (io.fetcher ?? fetch)(
        `http://127.0.0.1:${port}/api/mesh/keylog/status`,
        { signal: AbortSignal.timeout(5000), redirect: 'error' }
      );
      if (response.ok) {
        const body = (await response.json()) as MeshKeyLogStatus;
        if (body.userId === status.userId && isKeyLogStatus(body)) status = body;
      }
    } catch {
      // 网关停机时仍输出本地数据库日志头，不把未知远端误报为同步。
    }
    const verdict = keyLogStatusVerdict(status);
    log(
      io,
      `local: ${status.local ? `seq=${status.local.seq} hash=${status.local.hash}` : 'unknown'}`
    );
    log(
      io,
      `${status.remoteKind ?? 'hub/relay'}: ${status.remote ? `seq=${status.remote.seq} hash=${status.remote.hash}` : 'unknown'}`
    );
    log(io, verdict);
    if (verdict === 'FORK') log(io, t('mesh.keylog.fork'));
    if (verdict === 'UNKNOWN') log(io, t('mesh.keylog.unknown'));
    (
      io.setExitCode ??
      ((code) => {
        process.exitCode = code;
      })
    )(verdict === 'FORK' ? 2 : verdict === 'UNKNOWN' ? 1 : 0);
    return { ...status, verdict };
  });
}

function isKeyLogStatus(value: MeshKeyLogStatus): boolean {
  const validHead = (head: MeshKeyLogStatus['local']) =>
    head === null ||
    (typeof head === 'object' &&
      Number.isSafeInteger(head.seq) &&
      head.seq >= 0 &&
      typeof head.hash === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(head.hash));
  return (
    validHead(value.local) &&
    validHead(value.remote) &&
    [null, 'hub', 'relay'].includes(value.remoteKind) &&
    [value.localAtRemote, value.remoteAtLocal].every(
      (hash) => hash === null || (typeof hash === 'string' && /^[A-Za-z0-9_-]{43}$/.test(hash))
    )
  );
}
