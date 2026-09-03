import { describe, expect, test } from 'bun:test';
import { canonicalHubUrl } from '@tmex/shared/auth';
import { generateTenantKey } from '@tmex/shared/relay';
import { KeyLogStore } from '../auth/key-log-store';
import { ensureNodeIdentity } from '../auth/node-identity-service';
import { NodeIdentityStore } from '../auth/node-identity-store';
import { NodeSessionStore } from '../auth/node-session-store';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserKeyService } from '../auth/user-key-service';
import { UserStore } from '../auth/user-store';
import { buildMetaKeyPayload, buildSetRelaysPayload, listRelayNodeKeys } from './relay-payloads';
import { RelaySecrets } from './relay-secrets';

const RELAY_URL = 'https://relay.example';
const TENANT_ID = 'ab'.repeat(16);

async function boot() {
  const { db, close } = createMigratedAuthDb();
  const userStore = new UserStore(db);
  const service = new UserKeyService({
    db,
    userStore,
    keyLogStore: new KeyLogStore(db),
    nodeSessionStore: new NodeSessionStore(db),
  });
  const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
  const user = await service.bootstrapUserWithSelfAdmit({
    username: 'relay-user',
    password: 'relay-pass-1234',
    identity,
  });
  const secrets = new RelaySecrets({
    db,
    identity: {
      nodeIdHex: identity.nodeIdHex,
      x25519PrivateKey: identity.x25519PrivateKey,
    },
    userIdOf: () => user.userId,
  });
  return { db, close, userStore, service, identity, user, secrets };
}

function relayTarget(token: Uint8Array, priority = 0) {
  return { url: RELAY_URL, tenantId: TENANT_ID, token, priority };
}

describe('RelaySecrets', () => {
  test('set-relays 落库中继目标与租户密钥并切到 relay 模式', async () => {
    const b = await boot();
    try {
      const logKey = generateTenantKey();
      const metaKey = generateTenantKey();
      const token = new Uint8Array(32).fill(7);
      const nodes = listRelayNodeKeys(b.userStore, b.user.userId);
      expect(nodes.map((node) => node.nodeId)).toEqual([b.identity.nodeIdHex]);
      const payload = await buildSetRelaysPayload({
        relays: [relayTarget(token)],
        logKey,
        metaKey,
        metaEpoch: 1,
        nodes,
      });
      const applied = await b.service.signAndApply(b.user.userId, b.user.rootKey, {
        type: 'set-relays',
        payload,
      });
      expect(applied.ok).toBe(true);

      const result = await b.secrets.reconcile();
      expect(result.kind).toBe('relay');
      expect(result.targetsChanged).toBe(true);
      expect(result.metaEpoch).toBe(1);
      expect(b.secrets.uplinkKind()).toBe('relay');
      expect(b.secrets.relayRows()).toEqual([
        { url: canonicalHubUrl(RELAY_URL), tenantId: TENANT_ID, priority: 0, kicked: false },
      ]);
      expect(await b.secrets.logKey()).toEqual(logKey);
      expect(await b.secrets.metaKey(1)).toEqual(metaKey);
      const stored = await b.secrets.store.getRelay(canonicalHubUrl(RELAY_URL));
      expect(stored?.token).toEqual(token);
      expect(b.secrets.tenantId()).toBe(TENANT_ID);
    } finally {
      b.close();
    }
  });

  test('meta-key 轮换后保留旧世代密钥', async () => {
    const b = await boot();
    try {
      const logKey = generateTenantKey();
      const metaKey1 = generateTenantKey();
      const nodes = listRelayNodeKeys(b.userStore, b.user.userId);
      await b.service.signAndApply(b.user.userId, b.user.rootKey, {
        type: 'set-relays',
        payload: await buildSetRelaysPayload({
          relays: [relayTarget(new Uint8Array(32).fill(1))],
          logKey,
          metaKey: metaKey1,
          metaEpoch: 1,
          nodes,
        }),
      });
      await b.secrets.reconcile();

      const metaKey2 = generateTenantKey();
      const applied = await b.service.signAndApply(b.user.userId, b.user.rootKey, {
        type: 'meta-key',
        payload: await buildMetaKeyPayload({ metaKey: metaKey2, epoch: 2, nodes }),
      });
      expect(applied.ok).toBe(true);
      const result = await b.secrets.reconcile();
      expect(result.metaEpoch).toBe(2);
      expect(result.targetsChanged).toBe(false);
      expect(await b.secrets.metaKey(1)).toEqual(metaKey1);
      expect(await b.secrets.metaKey(2)).toEqual(metaKey2);
      expect(b.secrets.store.listSecretEpochs('meta')).toEqual([1, 2]);
      expect((await b.secrets.currentMetaKey())?.epoch).toBe(2);
    } finally {
      b.close();
    }
  });

  test('meta-key 不含本节点条目时停在旧世代只读', async () => {
    const b = await boot();
    try {
      const metaKey1 = generateTenantKey();
      const nodes = listRelayNodeKeys(b.userStore, b.user.userId);
      await b.service.signAndApply(b.user.userId, b.user.rootKey, {
        type: 'set-relays',
        payload: await buildSetRelaysPayload({
          relays: [relayTarget(new Uint8Array(32).fill(2))],
          logKey: generateTenantKey(),
          metaKey: metaKey1,
          metaEpoch: 1,
          nodes,
        }),
      });
      await b.secrets.reconcile();

      await b.service.signAndApply(b.user.userId, b.user.rootKey, {
        type: 'meta-key',
        payload: await buildMetaKeyPayload({ metaKey: generateTenantKey(), epoch: 2, nodes: [] }),
      });
      const result = await b.secrets.reconcile();
      expect(result.metaEpoch).toBe(1);
      expect(await b.secrets.metaKey(2)).toBeNull();
      expect(await b.secrets.metaKey(1)).toEqual(metaKey1);
    } finally {
      b.close();
    }
  });

  test('空 relays 的 set-relays 回到 hub 模式并清空目标', async () => {
    const b = await boot();
    try {
      const nodes = listRelayNodeKeys(b.userStore, b.user.userId);
      await b.service.signAndApply(b.user.userId, b.user.rootKey, {
        type: 'set-relays',
        payload: await buildSetRelaysPayload({
          relays: [relayTarget(new Uint8Array(32).fill(3))],
          logKey: generateTenantKey(),
          metaKey: generateTenantKey(),
          metaEpoch: 1,
          nodes,
        }),
      });
      await b.secrets.reconcile();
      expect(b.secrets.uplinkKind()).toBe('relay');

      await b.service.signAndApply(b.user.userId, b.user.rootKey, {
        type: 'set-relays',
        payload: await buildSetRelaysPayload({
          relays: [],
          logKey: new Uint8Array(32),
          metaKey: new Uint8Array(32),
          metaEpoch: 1,
          nodes,
        }),
      });
      const result = await b.secrets.reconcile();
      expect(result.kind).toBe('hub');
      expect(result.targetsChanged).toBe(true);
      expect(b.secrets.relayRows()).toEqual([]);
      expect(b.secrets.uplinkKind()).toBe('hub');
    } finally {
      b.close();
    }
  });

  test('currentState 把 relays/metaKeyEpoch/metaKeyEntries 投影回来', async () => {
    const b = await boot();
    try {
      const nodes = listRelayNodeKeys(b.userStore, b.user.userId);
      const token = new Uint8Array(32).fill(9);
      await b.service.signAndApply(b.user.userId, b.user.rootKey, {
        type: 'set-relays',
        payload: await buildSetRelaysPayload({
          relays: [relayTarget(token, 3)],
          logKey: generateTenantKey(),
          metaKey: generateTenantKey(),
          metaEpoch: 4,
          nodes,
        }),
      });
      const state = b.service.currentState(b.user.userId);
      expect(state.metaKeyEpoch).toBe(4);
      expect(state.metaKeyEntries.map((entry) => entry.node_id)).toEqual([b.identity.nodeIdHex]);
      expect(state.relays?.relays).toEqual([
        { url: canonicalHubUrl(RELAY_URL), tenantId: TENANT_ID, token, priority: 3 },
      ]);
      expect(state.relays?.logKeyEntries).toHaveLength(1);
    } finally {
      b.close();
    }
  });

  test('pending 密钥在记录里找不到自己时兜底', async () => {
    const b = await boot();
    try {
      const metaKey = generateTenantKey();
      const logKey = generateTenantKey();
      const payload = await buildSetRelaysPayload({
        relays: [relayTarget(new Uint8Array(32).fill(4))],
        logKey,
        metaKey,
        metaEpoch: 1,
        nodes: [],
      });
      b.secrets.stashPendingKeys(new Uint8Array(32).fill(1), { logKey, metaKey, epoch: 1 });
      await b.service.signAndApply(b.user.userId, b.user.rootKey, {
        type: 'set-relays',
        payload,
      });
      const result = await b.secrets.reconcile();
      expect(result.metaEpoch).toBe(1);
      expect(await b.secrets.metaKey(1)).toEqual(metaKey);
      expect(await b.secrets.logKey()).toEqual(logKey);
    } finally {
      b.close();
    }
  });
});
