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

type SealedRelayPack = {
  url: string;
  tenantId: string;
  token: Uint8Array;
  sealed: Uint8Array;
};

async function sealPackForRelay(input: {
  rootKey: RootKey;
  rootPublicKey: Uint8Array;
  rootEpoch: number;
  tenantId: string;
  token: Uint8Array;
  logKey: Uint8Array;
  headSeq: bigint;
  headHash: Uint8Array;
}): Promise<Uint8Array> {
  const tokenCopy = new Uint8Array(input.token);
  const logCopy = new Uint8Array(input.logKey);
  try {
    return await sealRelayPack({
      rootSeed: input.rootKey.seed,
      tenantId: input.tenantId,
      rootPublicKey: input.rootPublicKey,
      rootEpoch: input.rootEpoch,
      plaintext: {
        log_key: logCopy,
        token: tokenCopy,
        head_seq: input.headSeq,
        head_hash: input.headHash,
        issued_at: BigInt(Date.now()),
      },
    });
  } finally {
    tokenCopy.fill(0);
    logCopy.fill(0);
  }
}

async function sealPacksFromLocal(
  ctx: LocalAuthContext,
  rootKey: RootKey,
  userId: string
): Promise<{
  kdfParams: KdfParams;
  rootEpoch: number;
  headSeq: bigint;
  packs: SealedRelayPack[];
} | null> {
  const store = new MeshRelayStore(ctx.db);
  const rows = store.listRelayRows();
  if (rows.length === 0) return null;
  const user = ctx.userStore.getById(userId);
  const logKey = await store.getSecret('log', RELAY_LOG_KEY_EPOCH);
  const head = ctx.keyLogStore.head(userId);
  if (!user || !logKey || !head) return null;
  const kdfParams = kdfParamsFromJson(user.kdfParamsJson);
  const packs: SealedRelayPack[] = [];
  try {
    for (const row of rows) {
      const relay = await store.getRelay(row.url);
      if (!relay) continue;
      const sealed = await sealPackForRelay({
        rootKey,
        rootPublicKey: user.rootPublicKey,
        rootEpoch: user.rootEpoch,
        tenantId: relay.tenantId,
        token: relay.token,
        logKey,
        headSeq: head.seq,
        headHash: head.hash,
      });
      packs.push({
        url: relay.url,
        tenantId: relay.tenantId,
        token: relay.token,
        sealed,
      });
    }
  } finally {
    logKey.fill(0);
  }
  if (packs.length === 0) return null;
  return { kdfParams, rootEpoch: user.rootEpoch, headSeq: head.seq, packs };
}

async function postPacksToRelays(input: {
  packs: SealedRelayPack[];
  kdfParams: KdfParams;
  rootEpoch: number;
  headSeq: bigint;
  fetcher?: FetchLike;
}): Promise<void> {
  const headSeq =
    Number(input.headSeq) <= Number.MAX_SAFE_INTEGER
      ? Number(input.headSeq)
      : input.headSeq.toString();
  let lastError: unknown;
  let ok = false;
  for (const pack of input.packs) {
    try {
      await requestRelayJson({
        fetcher: input.fetcher,
        url: joinRelayUrl(pack.url, `/api/relay/tenants/${pack.tenantId}/pack`),
        method: 'POST',
        headers: { 'x-tmex-relay-token': encodeBase64url(pack.token) },
        body: {
          sealed_pack: encodeBase64url(pack.sealed),
          kdf_params: kdfParamsToWire(input.kdfParams),
          root_epoch: input.rootEpoch,
          head_seq: headSeq,
        },
        label: 'relay pack upload',
      });
      ok = true;
    } catch (error) {
      lastError = error;
    }
  }
  if (!ok && lastError) throw lastError;
}

/** 本机已接入中继时：按每台中继各自的 tenant/token 密封并 POST `/pack`。 */
export async function uploadRelayPackFromLocal(input: {
  ctx: LocalAuthContext;
  rootKey: RootKey;
  userId: string;
  fetcher?: FetchLike;
}): Promise<boolean> {
  const sealed = await sealPacksFromLocal(input.ctx, input.rootKey, input.userId);
  if (!sealed) return false;
  try {
    await postPacksToRelays({ ...sealed, fetcher: input.fetcher });
    return true;
  } finally {
    for (const pack of sealed.packs) pack.sealed.fill(0);
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
    path: '/api/mesh/relay/join-material?scope=all',
    label: 'relay join material',
  });
  const relays = Array.isArray(material.relays) ? material.relays : [];
  const logKeyRaw = typeof material.logKey === 'string' ? material.logKey : '';
  if (!logKeyRaw || relays.length === 0) {
    throw new Error('relay join-material missing tenant token or log key');
  }
  const head = await fetchKeyLogHead(input.session);
  const logKey = decodeBase64url(logKeyRaw);
  const packs: { url: string; sealed_pack: string }[] = [];
  try {
    for (const raw of relays) {
      const row = raw as { url?: string; tenantId?: string; token?: string };
      if (typeof row.url !== 'string' || typeof row.tenantId !== 'string') continue;
      if (typeof row.token !== 'string' || !row.token) continue;
      if (input.urls && !input.urls.includes(row.url)) continue;
      const token = decodeBase64url(row.token);
      try {
        const sealed = await sealPackForRelay({
          rootKey: input.rootKey,
          rootPublicKey: input.rootKey.publicKey,
          rootEpoch: head.rootEpoch,
          tenantId: row.tenantId,
          token,
          logKey,
          headSeq: head.seq,
          headHash: head.hash,
        });
        packs.push({ url: row.url, sealed_pack: encodeBase64url(sealed) });
      } finally {
        token.fill(0);
      }
    }
  } finally {
    logKey.fill(0);
  }
  if (packs.length === 0) {
    throw new Error('relay join-material missing tenant token or log key');
  }
  await relayGatewayRequest(input.session, {
    path: '/api/mesh/relay/pack',
    method: 'POST',
    body: {
      kdf_params: kdfParamsToWire(input.kdfParams),
      root_epoch: head.rootEpoch,
      head_seq:
        Number(head.seq) <= Number.MAX_SAFE_INTEGER ? Number(head.seq) : head.seq.toString(),
      packs,
    },
    label: 'relay pack upload',
  });
}
