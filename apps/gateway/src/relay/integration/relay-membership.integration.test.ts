import { afterEach, describe, expect, test } from 'bun:test';
import {
  createEnrollment,
  createNodeCertificate,
  encodeBase64url,
  signEd25519,
} from '@tmex/shared/auth';
import { RelayCipherError, openEnvelope } from '@tmex/shared/relay';
import { ensureNodeIdentity } from '../../auth';
import { NodeIdentityStore } from '../../auth/node-identity-store';
import { createMigratedAuthDb } from '../../auth/test-db';
import { encodeRedeemPopMessage } from '../../hub/redeem-pop';
import {
  HUB_NODE_ROLES,
  RELAY_TEST_PUBLIC_URL,
  type RelayMeshHarness,
  type RelayTenant,
  bootRelayMeshHarness,
  redeemAtRelay,
  waitUntil,
} from './relay-mesh-harness';

const HUB_A_URL = 'http://relay-migration-hub.test';

let harness: RelayMeshHarness | null = null;

afterEach(async () => {
  await harness?.stop();
  harness = null;
});

async function boot(opts?: Parameters<typeof bootRelayMeshHarness>[0]) {
  harness = await bootRelayMeshHarness(opts);
  return harness;
}

type RelayStatus = {
  mode: string;
  relays: Array<{ url: string; online: boolean; attached: boolean; kicked: boolean }>;
  metaEpoch: number;
  reauthRequired: boolean;
};

function relayRow(tenant: RelayTenant) {
  return tenant.owner.relayStore.listRelayRows()[0];
}

describe('relay password rotation', () => {
  test('kick 模式作废旧令牌，重新 enroll 后恢复', async () => {
    const h = await boot({ password: 'first-pass' });
    const tenant = await h.createTenant('alpha', { password: 'first-pass' });
    await tenant.enroll();
    const tenantId = tenant.tenantId();
    expect(h.relay.runtime.registry.get(tenantId, tenant.owner.nodeId)).toBeTruthy();

    const rotated = await h.relay.adminFetch('/api/relay/password', {
      method: 'POST',
      body: JSON.stringify({ password: 'second-pass', mode: 'kick' }),
    });
    expect(rotated.status).toBe(200);

    // relay.kicked 到达 → mesh_relays 打标、状态条要求重输口令、链路被断
    await waitUntil(() => relayRow(tenant)?.kicked === true, 8_000);
    await waitUntil(
      () => h.relay.runtime.registry.get(tenantId, tenant.owner.nodeId) == null,
      8_000
    );
    const kickedStatus = await tenant.owner.json<RelayStatus>('/api/mesh/relay/status');
    expect(kickedStatus.reauthRequired).toBe(true);

    // 旧口令再 enroll 也不行
    const stale = await tenant.enrollRaw({ password: 'first-pass' });
    expect(stale.status).toBe(401);

    // 新口令重新 enroll：租户号不变、换新令牌、kicked 清零、重新在线
    await tenant.enroll({ password: 'second-pass' });
    expect(tenant.tenantId()).toBe(tenantId);
    expect(relayRow(tenant)?.kicked).toBe(false);
    const healed = await tenant.owner.json<RelayStatus>('/api/mesh/relay/status');
    expect(healed.reauthRequired).toBe(false);
    expect(healed.relays[0]?.online).toBe(true);
  });

  test('keep 模式改密后旧令牌继续可用', async () => {
    const h = await boot({ password: 'first-pass' });
    const tenant = await h.createTenant('alpha', { password: 'first-pass' });
    await tenant.enroll();
    const tenantId = tenant.tenantId();
    const before = h.relay.runtime.registry.get(tenantId, tenant.owner.nodeId);

    const rotated = await h.relay.adminFetch('/api/relay/password', {
      method: 'POST',
      body: JSON.stringify({ password: 'second-pass', mode: 'keep' }),
    });
    expect(rotated.status).toBe(200);

    const status = await h.relay.adminFetch('/api/relay/status');
    const body = (await status.json()) as {
      config: { passwordEpoch: number; minTokenEpoch: number };
    };
    expect(body.config.passwordEpoch).toBe(2);
    expect(body.config.minTokenEpoch).toBe(0);

    // 链路没被换掉，节点侧也没有任何 kicked 标记
    expect(h.relay.runtime.registry.get(tenantId, tenant.owner.nodeId)).toBe(before);
    expect(relayRow(tenant)?.kicked).toBe(false);
    const nodeStatus = await tenant.owner.json<RelayStatus>('/api/mesh/relay/status');
    expect(nodeStatus.reauthRequired).toBe(false);
    expect(nodeStatus.relays[0]?.online).toBe(true);
  });
});

describe('relay node revocation', () => {
  test('吊销节点后 meta-key 轮换：被吊销方解不开新世代的状态块', async () => {
    const h = await boot();
    const tenant = await h.createTenant('alpha');
    await tenant.enroll();
    const b = await tenant.joinNode('alpha-b');
    const tenantId = tenant.tenantId();
    const oldEpoch = tenant.owner.metaEpochs().at(-1) ?? 0;
    const staleKey = await b.relayStore.getSecret('meta', oldEpoch);
    if (!staleKey) throw new Error('node b never received the current meta key');

    await tenant.revoke(b);
    const newEpoch = tenant.owner.metaEpochs().at(-1) ?? 0;
    expect(newEpoch).toBe(oldEpoch + 1);

    // 被吊销的节点拿不到新世代的密钥，也被中继踢出注册表
    expect(b.metaEpochs()).not.toContain(newEpoch);
    await waitUntil(
      () => h.relay.runtime.tenants.getNode(tenantId, b.nodeId)?.status === 'revoked',
      8_000
    );
    await waitUntil(() => h.relay.runtime.registry.get(tenantId, b.nodeId) == null, 8_000);

    // 主节点用新世代重新封状态块；旧密钥再也解不开
    await waitUntil(
      () =>
        (h.relay.runtime.registry.get(tenantId, tenant.owner.nodeId)?.statusEpoch ?? 0) ===
        newEpoch,
      8_000
    );
    const blob = h.relay.runtime.registry.get(tenantId, tenant.owner.nodeId)?.statusBlob;
    if (!blob) throw new Error('missing owner status blob');
    await expect(openEnvelope(staleKey, 'status', blob)).rejects.toBeInstanceOf(RelayCipherError);
    const freshKey = await tenant.owner.relayStore.getSecret('meta', newEpoch);
    if (!freshKey) throw new Error('owner lost its own meta key');
    expect((await openEnvelope(freshKey, 'status', blob)).byteLength).toBeGreaterThan(0);

    // 主节点侧成员表也已剔除
    expect(tenant.owner.userStore.getCert(b.nodeId)?.revokedLogSeq).not.toBeNull();
  });
});

describe('relay quotas', () => {
  test('节点数配额在 redeem 时生效', async () => {
    const h = await boot();
    const tenant = await h.createTenant('alpha');
    await tenant.enroll();
    const patched = await h.relay.adminFetch(`/api/relay/tenants/${tenant.tenantId()}`, {
      method: 'PATCH',
      body: JSON.stringify({
        quota: { maxNodes: 1, maxStreams: 32, bandwidthBytesPerSec: null },
      }),
    });
    expect(patched.status).toBe(200);

    const material = await tenant.owner.json<{ tenantId: string; token: string }>(
      '/api/mesh/relay/join-material'
    );
    const now = Date.now();
    const enrollment = await createEnrollment(tenant.rootKey, {
      uid: tenant.userId,
      rootEpoch: tenant.rootEpoch,
      now,
      ttlMs: 600_000,
    });
    const created = await tenant.owner.call('/api/mesh/relay/enrollments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enroll_pk: encodeBase64url(enrollment.enrollPk),
        authorization: encodeBase64url(enrollment.authorizationBytes),
        authorization_sig: encodeBase64url(enrollment.authorizationSig),
        exp: now + 600_000,
      }),
    });
    expect(created.status).toBe(201);

    const { db, close } = createMigratedAuthDb();
    try {
      const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
      const cert = createNodeCertificate(enrollment.enrollSk, {
        uid: tenant.userId,
        edPk: identity.edPublicKey,
        x25519Pk: identity.x25519PublicKey,
        enrollPk: enrollment.enrollPk,
        now,
        nodeId: identity.nodeId,
      });
      await expect(
        redeemAtRelay(h, material, {
          certificate: cert.certificateBytes,
          certSig: cert.certSig,
          pop: signEd25519(
            identity.edPrivateKey,
            encodeRedeemPopMessage({
              enrollmentId: encodeBase64url(enrollment.enrollPk),
              nodeId: identity.nodeId,
              certBytes: cert.certificateBytes,
            })
          ),
        })
      ).rejects.toThrow('RELAY_QUOTA_NODES');
    } finally {
      close();
    }
  });

  test('并发流配额生效：超额的 relay 流被 RST', async () => {
    const h = await boot();
    const tenant = await h.createTenant('alpha');
    await tenant.enroll();
    const b = await tenant.joinNode('alpha-b');
    const patched = await h.relay.adminFetch(`/api/relay/tenants/${tenant.tenantId()}`, {
      method: 'PATCH',
      body: JSON.stringify({
        quota: { maxNodes: 8, maxStreams: 1, bandwidthBytesPerSec: null },
      }),
    });
    expect(patched.status).toBe(200);

    const client = tenant.owner.relayClient();
    const peer = b.relayClient();
    if (!client || !peer) throw new Error('tenant is not on a relay');
    peer.setOnRelayStream(() => {});
    const first = await client.openRelay(b.nodeId);
    await first.write(new Uint8Array([1]));
    const second = await client.openRelay(b.nodeId);
    const info = await second.closed;
    expect(info.reason).toBe('rst');
    expect(info.message).toBe('quota-streams');
    first.end();
  });
});

describe('hub to relay migration', () => {
  test('hub,node 节点接入中继后切到中继上级，hub 集合清空', async () => {
    const h = await boot();
    const tenant = await h.createTenant('alpha', {
      roles: HUB_NODE_ROLES,
      hubPublicUrl: HUB_A_URL,
      selfHub: true,
    });
    await waitUntil(() => tenant.owner.mesh.uplink.state === 'online', 8_000);
    expect(tenant.owner.mesh.hub).not.toBeNull();
    expect(tenant.owner.mesh.attachedHub()?.publicUrl).toBe(HUB_A_URL);
    const before = await tenant.owner.json<RelayStatus>('/api/mesh/relay/status');
    expect(before.mode).toBe('hub');

    await tenant.enroll();

    // set-relays 落账后池子重建，上级换成中继；hub 集合被清空
    await waitUntil(
      () => tenant.owner.mesh.attachedHub()?.publicUrl === RELAY_TEST_PUBLIC_URL,
      8_000
    );
    const after = await tenant.owner.json<RelayStatus>('/api/mesh/relay/status');
    expect(after.mode).toBe('relay');
    expect(after.relays[0]?.attached).toBe(true);
    expect(after.metaEpoch).toBeGreaterThan(0);
    expect(tenant.owner.relayStore.uplinkKind()).toBe('relay');
    const hubs = await tenant.owner.json<{ hubs: unknown[] }>('/api/mesh/hubs');
    expect(hubs.hubs).toEqual([]);
    expect(h.relay.runtime.registry.get(tenant.tenantId(), tenant.owner.nodeId)).toBeTruthy();
  });
});
