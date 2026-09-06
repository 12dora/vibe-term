import {
  MeshRelayStore,
  RELAY_LOG_KEY_EPOCH,
} from '../../../../apps/gateway/src/auth/mesh-relay-store';
import { bytesEqual } from '../../../shared/src/auth';
import { RelayPackError, normalizeRelayUrl } from '../../../shared/src/relay';
import { RelayApiError, RelayTimeoutError } from '../commands/relay-shared';
import { errorMessage } from './error-message';
import type { FetchLike } from './fetch-like';
import type { LocalAuthContext } from './local-auth';
import { probeAddressForCli, probeNotFoundMessage } from './probe-address';
import { RelayCaError, fetchPinnedRelayCa, pinRelayCa } from './relay-ca';
import {
  RelayPasswordJoinError,
  joinDownloadVerifyReplay,
  joinKdfProofAndPack,
  joinSelfAdmitAndPersist,
  joinUploadAndEnv,
} from './relay-password-join-flow';

export { RelayPasswordJoinError } from './relay-password-join-flow';

const PACK_API_CODES = new Set([
  'RELAY_PACK_MISSING',
  'RELAY_PACK_EPOCH_MISMATCH',
  'RELAY_PACK_HEAD_AHEAD',
  'RELAY_PACK_TOO_LARGE',
]);

const PASSWORD_API_CODES = new Set(['RELAY_BAD_PROOF', 'RELAY_PASSWORD_INVALID']);

export type RelayPasswordJoinInput = {
  relayUrl: string;
  tenantId: string;
  password: string;
  name?: string;
  caFingerprint?: string;
};

export type RelayPasswordJoinDeps = {
  auth: LocalAuthContext;
  now?: () => number;
  fetcher?: FetchLike;
  timeoutMs?: number;
  log?: (message: string) => void;
  afterUnpack?: (pack: Awaited<ReturnType<typeof joinKdfProofAndPack>>) => void | Promise<void>;
};

export type RelayPasswordJoinResult = {
  userId: string;
  relayUrl: string;
  tenantId: string;
  /** 本机已经是该租户的成员，这次只换发了中继令牌（没有重建本机用户，也不用重启）。 */
  rekeyed?: boolean;
};

/**
 * 本机已有 mesh 用户时的处理方式。
 *
 * 覆盖别人的账户永远不行；但「同一个账户的成员节点因为令牌被换发而连不上」是真实的恢复场景——
 * 那台机器手里只剩一份作废的令牌，又因为连不上中继而拉不到带新令牌的 `set-relays`。
 * 此时用账户密码开密封包、只替换 `mesh_relays` 里的令牌即可，不重建用户、不动证书。
 */
type JoinMode = { kind: 'join' } | { kind: 'rekey'; userId: string; rootPublicKey: Uint8Array };

function parseJoinRelayUrl(raw: string): string {
  try {
    return normalizeRelayUrl(raw);
  } catch (error) {
    throw new RelayPasswordJoinError(
      'invalid_url',
      error instanceof Error ? error.message : 'invalid relay url'
    );
  }
}

/**
 * 地址没写端口时探候选端口；探不到按「中继不可达」报，与其它传输失败同一个错误码。
 * 显式端口按**原始输入**判断：`normalizeRelayUrl` 会抹掉 `:443`，归一化后再判会把用户写下的
 * 443 当成「没写端口」去遍历候选，可能静默接到另一台服务上。
 */
async function resolveJoinRelayPort(rawUrl: string, deps: RelayPasswordJoinDeps): Promise<string> {
  parseJoinRelayUrl(rawUrl);
  const probed = await probeAddressForCli(rawUrl.trim(), {
    kind: 'relay',
    fetcher: deps.fetcher,
    log: deps.log,
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
  });
  if (probed.probed && !probed.found) {
    throw new RelayPasswordJoinError('relay_unreachable', probeNotFoundMessage(probed.triedPorts));
  }
  return parseJoinRelayUrl(probed.url);
}

function isRelayUnreachableCause(error: unknown): boolean {
  if (error instanceof RelayTimeoutError) return true;
  if (error instanceof RelayCaError) return error.transport;
  if (!(error instanceof Error)) return false;
  if (error.name === 'TypeError') return true;
  const message = error.message.toLowerCase();
  return (
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('etimedout') ||
    message.includes('fetch failed') ||
    message.includes('unable to connect')
  );
}

export function wrapRelayPasswordJoinError(error: unknown): RelayPasswordJoinError {
  if (error instanceof RelayPasswordJoinError) {
    if (error.code === 'head_hash_mismatch') {
      return new RelayPasswordJoinError('relay_pack_invalid', error.message);
    }
    return error;
  }
  if (error instanceof RelayPackError) {
    return new RelayPasswordJoinError('relay_pack_invalid', error.message);
  }
  if (error instanceof RelayTimeoutError || isRelayUnreachableCause(error)) {
    return new RelayPasswordJoinError(
      'relay_unreachable',
      error instanceof Error ? error.message : 'relay unreachable'
    );
  }
  if (error instanceof RelayCaError) {
    return new RelayPasswordJoinError('join_failed', error.message);
  }
  if (error instanceof RelayApiError) {
    if (PASSWORD_API_CODES.has(error.code) || error.status === 401) {
      return new RelayPasswordJoinError('relay_password_invalid', error.message);
    }
    if (error.code === 'RELAY_TENANT_NOT_FOUND' || error.status === 404) {
      return new RelayPasswordJoinError('relay_tenant_unknown', error.message);
    }
    if (PACK_API_CODES.has(error.code)) {
      return new RelayPasswordJoinError('relay_pack_invalid', error.message);
    }
    return new RelayPasswordJoinError('join_failed', error.message);
  }
  return new RelayPasswordJoinError('join_failed', errorMessage(error));
}

function wrapJoinError(error: unknown): RelayPasswordJoinError {
  return wrapRelayPasswordJoinError(error);
}

async function resolveJoinMode(ctx: LocalAuthContext): Promise<JoinMode> {
  const users = ctx.userStore.listUsers();
  const identity = await ctx.identityStore.load();
  if (users.length === 0 && !identity?.userId) return { kind: 'join' };
  const only = users.length === 1 ? users[0] : undefined;
  if (!only || (identity?.userId && identity.userId !== only.id)) {
    throw new RelayPasswordJoinError(
      'local_user_exists',
      'this machine already has a mesh user; password join refuses to overwrite it'
    );
  }
  return { kind: 'rekey', userId: only.id, rootPublicKey: only.rootPublicKey };
}

async function pinnedFetcher(input: {
  relayUrl: string;
  caFingerprint: string | undefined;
  fetcher: FetchLike | undefined;
  timeoutMs: number | undefined;
}): Promise<{
  fetcher: FetchLike | undefined;
  pin: { caPem: string; fingerprint: string } | null;
}> {
  if (!input.caFingerprint) return { fetcher: input.fetcher, pin: null };
  const caPem = await fetchPinnedRelayCa({
    relayUrl: input.relayUrl,
    fingerprint: input.caFingerprint,
    fetcher: input.fetcher,
    timeoutMs: input.timeoutMs,
  });
  return {
    fetcher: pinRelayCa(input.fetcher, caPem),
    pin: { caPem, fingerprint: input.caFingerprint },
  };
}

/** 只换令牌：用密封包里的当前令牌覆盖 `mesh_relays` 那一行，并刷新 `K_log`。 */
async function rekeyRelayToken(
  mode: Extract<JoinMode, { kind: 'rekey' }>,
  ctx: LocalAuthContext,
  transport: { relayUrl: string; tenantId: string },
  pack: Awaited<ReturnType<typeof joinKdfProofAndPack>>,
  now: number
): Promise<RelayPasswordJoinResult> {
  if (!bytesEqual(pack.rootKey.publicKey, mode.rootPublicKey)) {
    throw new RelayPasswordJoinError(
      'local_user_exists',
      'this machine belongs to a different mesh account; password join refuses to overwrite it'
    );
  }
  const store = new MeshRelayStore(ctx.db);
  await store.setRelayToken({
    url: transport.relayUrl,
    tenantId: transport.tenantId,
    token: pack.pack.token,
    now,
  });
  await store.putSecret('log', RELAY_LOG_KEY_EPOCH, pack.pack.log_key, now);
  store.setUplinkKind('relay');
  return {
    userId: mode.userId,
    relayUrl: transport.relayUrl,
    tenantId: transport.tenantId,
    rekeyed: true,
  };
}

export async function performRelayPasswordJoin(
  input: RelayPasswordJoinInput,
  deps: RelayPasswordJoinDeps
): Promise<RelayPasswordJoinResult> {
  const mode = await resolveJoinMode(deps.auth);
  const relayUrl = await resolveJoinRelayPort(input.relayUrl, deps);
  const tenantId = input.tenantId.trim().toLowerCase();
  const { fetcher, pin } = await pinnedFetcher({
    relayUrl,
    caFingerprint: input.caFingerprint,
    fetcher: deps.fetcher,
    timeoutMs: deps.timeoutMs,
  });
  const transport = { relayUrl, tenantId, fetcher, timeoutMs: deps.timeoutMs };
  let pack: Awaited<ReturnType<typeof joinKdfProofAndPack>> | undefined;
  let metaKey: Uint8Array | undefined;
  try {
    pack = await joinKdfProofAndPack({
      ...transport,
      password: input.password,
      now: deps.now?.() ?? Date.now(),
    });
    await deps.afterUnpack?.(pack);
    if (mode.kind === 'rekey') {
      return await rekeyRelayToken(mode, deps.auth, transport, pack, deps.now?.() ?? Date.now());
    }
    const log = await joinDownloadVerifyReplay(transport, pack);
    const admit = await joinSelfAdmitAndPersist({
      auth: deps.auth,
      transport,
      pack,
      log,
      name: input.name,
    });
    metaKey = admit.metaKey;
    await joinUploadAndEnv({ auth: deps.auth, transport, pack, log, admit, pin });
    return { userId: log.genesisUid, relayUrl, tenantId };
  } catch (error) {
    throw wrapJoinError(error);
  } finally {
    pack?.pack.log_key.fill(0);
    pack?.pack.token.fill(0);
    pack?.rootKey.seed.fill(0);
    metaKey?.fill(0);
  }
}
