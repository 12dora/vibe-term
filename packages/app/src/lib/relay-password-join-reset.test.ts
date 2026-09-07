import './test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { RELAY_LOG_KEY_EPOCH } from '../../../../apps/gateway/src/auth/mesh-relay-store';
import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import { kdfParamsFromJson } from '../../../../apps/gateway/src/auth/user-key-service';
import {
  buildSetRelaysPayload,
  listRelayNodeKeys,
} from '../../../../apps/gateway/src/mesh/relay-payloads';
import { RelaySecrets } from '../../../../apps/gateway/src/mesh/relay-secrets';
import {
  type RelayHarness,
  bootRelayHarness,
  enrollRelayRoot,
} from '../../../../apps/gateway/src/relay/relay-test-harness';
import {
  decodeBase64url,
  decodeKeyLogRecord,
  encodeBase64url,
  encodeRevokeNodePayload,
} from '../../../shared/src/auth';
import {
  findWrapEntry,
  kdfParamsToWire,
  sealRelayPack,
  unwrapKeyForNode,
} from '../../../shared/src/relay';
import { runMeshResetIdentity } from '../commands/mesh';
import { parseArgs } from './args';
import type { FetchLike } from './fetch-like';
import { type LocalAuthContext, openLocalAuth } from './local-auth';
import { performRelayPasswordJoin } from './relay-password-join';
import { appendOneJoinRecord } from './relay-password-join-append';

const RELAY_URL = 'https://relay.example';
const PASSWORD = 'reset-identity-password';
const handles: LocalAuthContext[] = [];
const relays: RelayHarness[] = [];

afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close();
  for (const auth of handles.splice(0)) auth.close();
});

async function fixture() {
  const relay = await bootRelayHarness();
  relays.push(relay);
  const auth = await openLocalAuth({ memory: true });
  handles.push(auth);
  const identity = await ensureNodeIdentity(auth.identityStore);
  const user = await auth.userKeys.bootstrapUserWithSelfAdmit({
    username: 'recovering-member',
    password: PASSWORD,
    identity,
    now: relay.now(),
  });
  const enrolled = await enrollRelayRoot(relay, user.rootKey, { rootEpoch: user.rootEpoch });
  if (!enrolled.token) throw new Error('missing relay token');
  const token = decodeBase64url(enrolled.token);
  const tenantId = enrolled.tenant_id;
  const logKey = new Uint8Array(32).fill(4);
  const fetcher: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    return relay.fetch(`${url.pathname}${url.search}`, init);
  };
  const transport = { relayUrl: RELAY_URL, tenantId, fetcher };
  const signed = await auth.userKeys.signAndApply(user.userId, user.rootKey, {
    type: 'set-relays',
    payload: await buildSetRelaysPayload({
      relays: [{ url: RELAY_URL, tenantId, token, priority: 0 }],
      logKey,
      metaKey: new Uint8Array(32).fill(5),
      metaEpoch: 1,
      nodes: listRelayNodeKeys(auth.userStore, user.userId),
    }),
  });
  if (!signed.ok) throw new Error(signed.error);
  const secrets = new RelaySecrets({ db: auth.db, identity, userIdOf: () => user.userId });
  await secrets.reconcile();
  async function publish() {
    const remoteHead = relay.runtime.keyLog.head(tenantId);
    for (const row of auth.keyLogStore.list(user.userId).filter((row) => row.seq > remoteHead)) {
      await appendOneJoinRecord({ ...transport, token, logKey, record: row });
    }
    const head = auth.keyLogStore.head(user.userId);
    const localUser = auth.userStore.getById(user.userId);
    if (!head || !localUser) throw new Error('missing local keylog');
    const sealed = await sealRelayPack({
      rootSeed: user.rootKey.seed,
      rootPublicKey: user.rootKey.publicKey,
      rootEpoch: user.rootEpoch,
      tenantId,
      plaintext: {
        log_key: logKey.slice(),
        token: token.slice(),
        head_seq: head.seq,
        head_hash: head.hash,
        issued_at: BigInt(relay.now()),
      },
    });
    const uploaded = await relay.tenantFetch(
      `/api/relay/tenants/${tenantId}/pack`,
      enrolled.token ?? '',
      {
        method: 'POST',
        body: JSON.stringify({
          sealed_pack: encodeBase64url(sealed),
          kdf_params: kdfParamsToWire(kdfParamsFromJson(localUser.kdfParamsJson)),
          root_epoch: user.rootEpoch,
          head_seq: Number(head.seq),
        }),
      }
    );
    if (!uploaded.ok) throw new Error(`pack upload: ${await uploaded.text()}`);
  }
  await publish();
  return {
    auth,
    relay,
    identity,
    user,
    tenantId,
    secrets,
    logKey,
    token,
    publish,
    join: () =>
      performRelayPasswordJoin(
        { relayUrl: RELAY_URL, tenantId, password: PASSWORD },
        { auth, fetcher, now: relay.now }
      ),
  };
}

describe('relay password join identity membership', () => {
  test('reset-identity then password join self-admits the new identity and wraps its metadata key', async () => {
    const f = await fixture();
    const before = f.auth.keyLogStore.head(f.user.userId);
    const reset = await runMeshResetIdentity(parseArgs(['mesh', 'reset-identity', '--yes']), {
      auth: f.auth,
      log: () => {},
    });
    expect(reset.nodeId).not.toBe(f.identity.nodeIdHex);
    expect((await f.auth.identityStore.load())?.userId).toBeNull();
    expect(await f.secrets.store.getSecret('log', RELAY_LOG_KEY_EPOCH)).toBeNull();
    expect(await f.join()).toEqual({
      userId: f.user.userId,
      relayUrl: RELAY_URL,
      tenantId: f.tenantId,
    });
    const identity = await ensureNodeIdentity(f.auth.identityStore);
    expect((await f.auth.identityStore.load())?.userId).toBe(f.user.userId);
    expect(identity.nodeIdHex).toBe(reset.nodeId);
    const state = f.auth.userKeys.currentState(f.user.userId);
    expect(state.nodeCerts.get(reset.nodeId)?.revoked).toBe(false);
    expect(state.head.seq).toBe((before?.seq ?? 0n) + 2n);
    expect(f.relay.runtime.keyLog.head(f.tenantId)).toBe(state.head.seq);
    expect(f.relay.runtime.tenants.getNode(f.tenantId, reset.nodeId)?.status).toBe('admitted');
    const appended = f.auth.keyLogStore.list(f.user.userId).slice(-2);
    expect(appended.map((row) => decodeKeyLogRecord(row.bytes).type)).toEqual([
      'admit-node',
      'meta-key',
    ]);
    const entry = findWrapEntry(state.metaKeyEntries, reset.nodeId);
    expect(entry).toBeDefined();
    if (!entry) throw new Error('missing new identity key wrap');
    const key = await unwrapKeyForNode({ entry, nodeX25519Sk: identity.x25519PrivateKey });
    expect(await f.secrets.store.getSecret('meta', state.metaKeyEpoch)).toEqual(key);
    expect(await f.secrets.store.getSecret('log', RELAY_LOG_KEY_EPOCH)).toEqual(f.logKey);
    expect((await f.secrets.store.getRelay(RELAY_URL))?.token).toEqual(f.token);
    expect(f.auth.userStore.listUsers()).toHaveLength(1);
    expect(f.auth.userStore.getById(f.user.userId)?.username).toBe('recovering-member');
  });

  test('an admitted identity retains the token-only rekey path', async () => {
    const f = await fixture();
    const before = f.auth.keyLogStore.head(f.user.userId);
    expect((await f.join()).rekeyed).toBe(true);
    expect((await f.auth.identityStore.load())?.nodeId).toBe(f.identity.nodeIdHex);
    expect(f.auth.userKeys.currentState(f.user.userId).head.seq).toBe((before?.seq ?? 0n) + 1n);
    const last = f.auth.keyLogStore.list(f.user.userId).at(-1);
    expect(decodeKeyLogRecord(last?.bytes ?? new Uint8Array()).type).toBe('set-relays');
  });

  test('reset identity still refuses a relay log that does not include the local head', async () => {
    const f = await fixture();
    await f.join();
    const applied = await f.auth.userKeys.signAndApply(f.user.userId, f.user.rootKey, {
      type: 'revoke-node',
      payload: encodeRevokeNodePayload({ node_id: f.identity.nodeId, reason: 'local-only' }),
    });
    expect(applied.ok).toBe(true);
    await runMeshResetIdentity(parseArgs(['mesh', 'reset-identity', '--yes']), {
      auth: f.auth,
      log: () => {},
    });
    const remoteHead = f.relay.runtime.keyLog.head(f.tenantId);
    const localHead = f.auth.keyLogStore.head(f.user.userId);
    await expect(f.join()).rejects.toMatchObject({ code: 'local_user_exists' });
    expect(f.relay.runtime.keyLog.head(f.tenantId)).toBe(remoteHead);
    expect(f.auth.keyLogStore.head(f.user.userId)).toEqual(localHead);
    expect((await f.auth.identityStore.load())?.userId).toBeNull();
  });

  test('a revoked identity cannot recover through the token-only rekey path', async () => {
    const f = await fixture();
    const revoked = await f.auth.userKeys.signAndApply(f.user.userId, f.user.rootKey, {
      type: 'revoke-node',
      payload: encodeRevokeNodePayload({ node_id: f.identity.nodeId, reason: 'lost' }),
    });
    expect(revoked.ok).toBe(true);
    await f.publish();
    const before = f.auth.keyLogStore.head(f.user.userId);
    await expect(f.join()).rejects.toMatchObject({ code: 'join_failed' });
    expect(f.auth.keyLogStore.head(f.user.userId)).toEqual(before);
    expect(f.relay.runtime.tenants.getNode(f.tenantId, f.identity.nodeIdHex)?.status).toBe(
      'revoked'
    );
  });
});
