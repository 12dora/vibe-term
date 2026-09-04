import {
  MeshRelayStore,
  RELAY_LOG_KEY_EPOCH,
} from '../../../../apps/gateway/src/auth/mesh-relay-store';
import { kdfParamsFromJson } from '../../../../apps/gateway/src/auth/user-key-service';
import {
  type KdfParams,
  type RootKey,
  decodeBase64url,
  encodeBase64url,
} from '../../../shared/src/auth';
import { kdfParamsToWire, sealRelayPack } from '../../../shared/src/relay';
import { joinRelayUrl, requestRelayJson } from '../commands/relay-shared';
import type { FetchLike } from './fetch-like';
import type { LocalAuthContext } from './local-auth';
import { type RelayTenantSession, fetchKeyLogHead, relayGatewayRequest } from './relay-session';

async function sealPackFromLocal(
  ctx: LocalAuthContext,
  rootKey: RootKey,
  userId: string
): Promise<{
  tenantId: string;
  sealed: Uint8Array;
  kdfParams: KdfParams;
  rootEpoch: number;
  headSeq: bigint;
  relays: { url: string; tenantId: string; token: Uint8Array }[];
} | null> {
  const store = new MeshRelayStore(ctx.db);
  const rows = store.listRelayRows();
  if (rows.length === 0) return null;
  const user = ctx.userStore.getById(userId);
  const logKey = await store.getSecret('log', RELAY_LOG_KEY_EPOCH);
  const head = ctx.keyLogStore.head(userId);
  if (!user || !logKey || !head) return null;
  const relays: { url: string; tenantId: string; token: Uint8Array }[] = [];
  for (const row of rows) {
    const relay = await store.getRelay(row.url);
    if (relay) relays.push({ url: relay.url, tenantId: relay.tenantId, token: relay.token });
  }
  const primary = relays[0];
  if (!primary) return null;
  const kdfParams = kdfParamsFromJson(user.kdfParamsJson);
  const tokenCopy = new Uint8Array(primary.token);
  const logCopy = new Uint8Array(logKey);
  try {
    const sealed = await sealRelayPack({
      rootSeed: rootKey.seed,
      tenantId: primary.tenantId,
      rootPublicKey: user.rootPublicKey,
      rootEpoch: user.rootEpoch,
      plaintext: {
        log_key: logCopy,
        token: tokenCopy,
        head_seq: head.seq,
        head_hash: head.hash,
        issued_at: BigInt(Date.now()),
      },
    });
    return {
      tenantId: primary.tenantId,
      sealed,
      kdfParams,
      rootEpoch: user.rootEpoch,
      headSeq: head.seq,
      relays,
    };
  } finally {
    tokenCopy.fill(0);
    logCopy.fill(0);
    logKey.fill(0);
  }
}

async function postPackToRelays(input: {
  relays: { url: string; tenantId: string; token: Uint8Array }[];
  sealed: Uint8Array;
  kdfParams: KdfParams;
  rootEpoch: number;
  headSeq: bigint;
  fetcher?: FetchLike;
}): Promise<void> {
  const body = {
    sealed_pack: encodeBase64url(input.sealed),
    kdf_params: kdfParamsToWire(input.kdfParams),
    root_epoch: input.rootEpoch,
    head_seq:
      Number(input.headSeq) <= Number.MAX_SAFE_INTEGER
        ? Number(input.headSeq)
        : input.headSeq.toString(),
  };
  let lastError: unknown;
  let ok = false;
  for (const relay of input.relays) {
    try {
      await requestRelayJson({
        fetcher: input.fetcher,
        url: joinRelayUrl(relay.url, `/api/relay/tenants/${relay.tenantId}/pack`),
        method: 'POST',
        headers: { 'x-tmex-relay-token': encodeBase64url(relay.token) },
        body,
        label: 'relay pack upload',
      });
      ok = true;
    } catch (error) {
      lastError = error;
    }
  }
  if (!ok && lastError) throw lastError;
}

/** 本机已接入中继时：用当前根种子密封并直接打各中继的 `/pack`（enroll / 改密）。 */
export async function uploadRelayPackFromLocal(input: {
  ctx: LocalAuthContext;
  rootKey: RootKey;
  userId: string;
  fetcher?: FetchLike;
}): Promise<boolean> {
  const sealed = await sealPackFromLocal(input.ctx, input.rootKey, input.userId);
  if (!sealed) return false;
  try {
    await postPackToRelays({ ...sealed, fetcher: input.fetcher });
    return true;
  } finally {
    sealed.sealed.fill(0);
  }
}

/** 经本机 gateway `POST /api/mesh/relay/pack` 转发（网页 / 已登录 node-session）。 */
export async function sealAndUploadRelayPack(input: {
  session: RelayTenantSession;
  rootKey: RootKey;
  kdfParams: KdfParams;
  urls?: string[];
}): Promise<void> {
  const material = await relayGatewayRequest(input.session, {
    path: '/api/mesh/relay/join-material',
    label: 'relay join material',
  });
  const relays = Array.isArray(material.relays) ? material.relays : [];
  const primary = relays[0] as { url?: string; tenantId?: string; token?: string } | undefined;
  const tenantId = typeof primary?.tenantId === 'string' ? primary.tenantId : '';
  const tokenRaw = typeof primary?.token === 'string' ? primary.token : '';
  const logKeyRaw = typeof material.logKey === 'string' ? material.logKey : '';
  if (!tenantId || !tokenRaw || !logKeyRaw) {
    throw new Error('relay join-material missing tenant token or log key');
  }
  const head = await fetchKeyLogHead(input.session);
  const token = decodeBase64url(tokenRaw);
  const logKey = decodeBase64url(logKeyRaw);
  let sealed: Uint8Array;
  try {
    sealed = await sealRelayPack({
      rootSeed: input.rootKey.seed,
      tenantId,
      rootPublicKey: input.rootKey.publicKey,
      rootEpoch: head.rootEpoch,
      plaintext: {
        log_key: logKey,
        token,
        head_seq: head.seq,
        head_hash: head.hash,
        issued_at: BigInt(Date.now()),
      },
    });
  } finally {
    logKey.fill(0);
    token.fill(0);
  }
  await relayGatewayRequest(input.session, {
    path: '/api/mesh/relay/pack',
    method: 'POST',
    body: {
      sealed_pack: encodeBase64url(sealed),
      kdf_params: kdfParamsToWire(input.kdfParams),
      root_epoch: head.rootEpoch,
      head_seq:
        Number(head.seq) <= Number.MAX_SAFE_INTEGER ? Number(head.seq) : head.seq.toString(),
      ...(input.urls ? { urls: input.urls } : {}),
    },
    label: 'relay pack upload',
  });
}
