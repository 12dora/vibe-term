import { afterEach, describe, expect, test } from 'bun:test';
import {
  createEnrollment,
  createNodeCertificate,
  decodeAuthorization,
  decodeBase64url,
  encodeBase64url,
  signEd25519,
} from '@tmex/shared/auth';
import { openEnvelope, signRelayEnrollProof } from '@tmex/shared/relay';
import { ensureNodeIdentity } from '../../auth';
import { NodeIdentityStore } from '../../auth/node-identity-store';
import { createMigratedAuthDb } from '../../auth/test-db';
import { encodeRedeemPopMessage } from '../../hub/redeem-pop';
import {
  RELAY_TEST_PUBLIC_URL,
  type RelayMeshHarness,
  bootRelayMeshHarness,
  openRelayKeyLogPage,
  redeemAtRelay,
  waitUntil,
  waitUntilAsync,
} from './relay-mesh-harness';

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
  tenantId: string | null;
  relays: Array<{ url: string; online: boolean; attached: boolean; kicked: boolean }>;
  metaEpoch: number;
  nodesViaRelay: number;
  reauthRequired: boolean;
};

describe('relay enroll and tenant fan-out', () => {
  test('口令 enroll 后 set-relays 落到两个节点，双方都能解出对方状态块', async () => {
    const h = await boot({ password: 'relay-pass' });
    const tenant = await h.createTenant('alpha', { password: 'relay-pass' });
    await tenant.enroll();
    const b = await tenant.joinNode('alpha-b');

    // set-relays 记录在两侧都落库：mesh_relays 指向同一个中继、同一个租户
    expect(tenant.owner.relayStore.uplinkKind()).toBe('relay');
    expect(b.relayStore.uplinkKind()).toBe('relay');
    expect(b.relayStore.listRelayRows()[0]?.url).toBe(RELAY_TEST_PUBLIC_URL);
    expect(b.relayStore.listRelayRows()[0]?.tenantId).toBe(tenant.tenantId());

    // 双方都 attach 到中继，并通过解密的 relay.list 状态块互相看见
    await waitUntil(() => tenant.owner.userStore.getPeer(b.nodeId)?.name === 'alpha-b', 8_000);
    await waitUntil(() => b.userStore.getPeer(tenant.owner.nodeId)?.name === 'alpha-a', 8_000);
    const status = await tenant.owner.json<RelayStatus>('/api/mesh/relay/status');
    expect(status.mode).toBe('relay');
    expect(status.relays[0]?.attached).toBe(true);
    expect(status.relays[0]?.online).toBe(true);
    expect(status.reauthRequired).toBe(false);
    await waitUntil(() => tenant.owner.relayClient()?.nodesViaRelay === 1, 8_000);

    // 中继只看到密文块：租户密钥能解开，随机密钥解不开
    const live = h.relay.runtime.registry.get(tenant.tenantId(), b.nodeId);
    expect(live?.statusBlob).toBeTruthy();
    const metaKey = await b.relayStore.getSecret('meta', b.metaEpochs()[0] ?? 0);
    if (!metaKey || !live?.statusBlob) throw new Error('missing meta key or status blob');
    const plaintext = await openEnvelope(metaKey, 'status', live.statusBlob);
    expect(JSON.parse(new TextDecoder().decode(plaintext)).name).toBe('alpha-b');
  });

  test('enroll proof 端到端：/api/mesh/relay/enroll → 中继 /api/relay/enroll', async () => {
    const h = await boot({ password: 'relay-pass' });
    const tenant = await h.createTenant('alpha');

    // 口令不对：中继 401，节点透传状态码与中继的错误码
    const wrongPassword = await tenant.enrollRaw({ password: 'nope' });
    expect(wrongPassword.status).toBe(401);
    expect((await wrongPassword.json()).code).toBe('RELAY_PASSWORD_INVALID');

    // proof 由别的根钥签：节点本地就拒绝，不打中继
    const material = await tenant.owner.json<{ relayHost: string; ts: number }>(
      '/api/mesh/relay/enroll/proof-material',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: RELAY_TEST_PUBLIC_URL }),
      }
    );
    const otherTenant = await h.createTenant('beta');
    const forged = signRelayEnrollProof(otherTenant.rootKey, {
      relayHost: material.relayHost,
      ts: material.ts,
    });
    const badProof = await tenant.owner.call('/api/mesh/relay/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: RELAY_TEST_PUBLIC_URL,
        password: 'relay-pass',
        proof: { bytes: encodeBase64url(forged.bytes), sig: encodeBase64url(forged.sig) },
      }),
    });
    expect(badProof.status).toBe(400);
    expect((await badProof.json()).code).toBe('BAD_PROOF');

    // 正确口令 + 正确 proof：拿到租户号与令牌，并附带待签的 set-relays payload
    const ok = await tenant.enrollRaw({ password: 'relay-pass' });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { tenantId: string; token: string; payload: string };
    expect(body.tenantId).toMatch(/^[0-9a-f]{32}$/);
    expect(decodeBase64url(body.token).byteLength).toBe(32);
    expect(decodeBase64url(body.payload).byteLength).toBeGreaterThan(0);
    expect(h.relay.runtime.tenants.get(body.tenantId)).toBeTruthy();
  });
});

describe('relay tenant isolation', () => {
  test('两个租户互不可见：relay.list 不含对方，跨租户 relay 流被 RST', async () => {
    const h = await boot();
    const alpha = await h.createTenant('alpha');
    await alpha.enroll();
    const alphaB = await alpha.joinNode('alpha-b');
    const beta = await h.createTenant('beta');
    await beta.enroll();
    const betaB = await beta.joinNode('beta-b');

    await waitUntil(() => alpha.owner.relayClient()?.nodesViaRelay === 1, 8_000);
    await waitUntil(() => beta.owner.relayClient()?.nodesViaRelay === 1, 8_000);
    expect(alpha.tenantId()).not.toBe(beta.tenantId());

    // peer_cache 只有同租户成员
    await waitUntil(() => alpha.owner.userStore.listPeers().length === 1, 8_000);
    await waitUntil(() => beta.owner.userStore.listPeers().length === 1, 8_000);
    expect(alpha.owner.userStore.listPeers().map((p) => p.nodeId)).toEqual([alphaB.nodeId]);
    expect(beta.owner.userStore.listPeers().map((p) => p.nodeId)).toEqual([betaB.nodeId]);
    expect(alpha.owner.userStore.getPeer(betaB.nodeId)).toBeNull();
    expect(beta.owner.userStore.getPeer(alphaB.nodeId)).toBeNull();

    // 跨租户开 relay 流：中继找不到目标，直接 RST
    const client = alpha.owner.relayClient();
    if (!client) throw new Error('alpha owner is not on a relay');
    const stream = await client.openRelay(betaB.nodeId);
    const info = await stream.closed;
    expect(info.reason).toBe('rst');
    expect(info.message).toBe('unknown-target');

    // 同租户开流可用（对照组）：中继把首帧连同 from 转给目标节点
    const peerClient = alphaB.relayClient();
    if (!peerClient) throw new Error('alpha-b is not on a relay');
    const inbound = new Promise<string>((resolve) => {
      peerClient.setOnRelayStream((_stream, from) => resolve(from));
    });
    const ok = await client.openRelay(alphaB.nodeId);
    expect(await inbound).toBe(alpha.owner.nodeId);
    ok.end();

    // alpha 的租户令牌不能读 beta 的 enrollment
    const alphaToken = encodeBase64url(
      (await alpha.owner.relayStore.getRelay(RELAY_TEST_PUBLIC_URL))?.token ?? new Uint8Array(32)
    );
    const cross = await h.relay.tenantFetch(
      `/api/relay/tenants/${beta.tenantId()}/enrollments/${encodeURIComponent(
        encodeBase64url(new Uint8Array(32).fill(3))
      )}`,
      alphaToken
    );
    expect(cross.status).toBe(401);
  });
});

describe('relay key log sync', () => {
  test('A 追加记录经中继推给 B；迟到的节点下载整段积压', async () => {
    const h = await boot();
    const tenant = await h.createTenant('alpha');
    await tenant.enroll();
    const b = await tenant.joinNode('alpha-b');

    // 迟到节点：join 时下载的整链能对上主节点 head，且逐条可解
    const ownerHead = await tenant.owner.keys.head(tenant.userId);
    await waitUntilAsync(
      async () => (await b.keys.head(tenant.userId)).seq >= ownerHead.seq,
      8_000
    );
    expect((await b.keys.head(tenant.userId)).hash).toEqual(ownerHead.hash);

    // 主节点新签一条 meta-key，B 通过 relay.keylog.push 收到并应用
    const before = tenant.owner.relayStore.listSecretEpochs('meta').at(-1) ?? 0;
    await tenant.rotateMetaKey();
    const after = tenant.owner.relayStore.listSecretEpochs('meta').at(-1) ?? 0;
    expect(after).toBe(before + 1);
    await waitUntil(() => b.metaEpochs().includes(after), 8_000);
    const headAfter = await tenant.owner.keys.head(tenant.userId);
    await waitUntilAsync(
      async () => (await b.keys.head(tenant.userId)).seq === headAfter.seq,
      8_000
    );
    expect(h.relay.runtime.tenants.get(tenant.tenantId())?.keyLogHeadSeq).toBe(headAfter.seq);
  });
});

describe('relay r3 join path', () => {
  test('CLI 用的两条中继路由：enrollment 查询 + redeem 返回可解的整段日志', async () => {
    const h = await boot();
    const tenant = await h.createTenant('alpha');
    await tenant.enroll();
    const material = await tenant.owner.json<{
      tenantId: string;
      token: string;
      logKey: string;
    }>('/api/mesh/relay/join-material');
    expect(material.tenantId).toBe(tenant.tenantId());
    expect(decodeBase64url(material.logKey).byteLength).toBe(32);

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

    // GET /api/relay/tenants/:id/enrollments/:enrollPk —— 加入方据此取 uid 再造证书
    const lookup = await h.relay.tenantFetch(
      `/api/relay/tenants/${material.tenantId}/enrollments/${encodeURIComponent(
        encodeBase64url(enrollment.enrollPk)
      )}`,
      material.token
    );
    expect(lookup.status).toBe(200);
    const lookupBody = (await lookup.json()) as { authorization: string; used_at: number | null };
    expect(lookupBody.used_at).toBeNull();
    expect(decodeAuthorization(decodeBase64url(lookupBody.authorization)).uid).toBe(tenant.userId);

    // 令牌不对一律 404，不区分「不存在」与「不是你的」
    const denied = await h.relay.tenantFetch(
      `/api/relay/tenants/${material.tenantId}/enrollments/${encodeURIComponent(
        encodeBase64url(enrollment.enrollPk)
      )}`,
      encodeBase64url(new Uint8Array(32).fill(9))
    );
    expect(denied.status).toBe(401);

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
      const redeemed = await redeemAtRelay(h, material, {
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
      });
      expect(redeemed.relays).toEqual([RELAY_TEST_PUBLIC_URL]);
      const records = await openRelayKeyLogPage(decodeBase64url(material.logKey), redeemed.key_log);
      expect(records.length).toBeGreaterThan(0);
      const head = await tenant.owner.keys.head(tenant.userId);
      expect(BigInt(records.length)).toBe(head.seq);
      // 中继侧登记为 pending，等待主节点签 admit-node
      expect(h.relay.runtime.tenants.getNode(material.tenantId, identity.nodeIdHex)?.status).toBe(
        'pending'
      );
      // redeem 只能用一次
      const replay = await h.relay.tenantFetch(
        `/api/relay/tenants/${material.tenantId}/enrollments/redeem`,
        material.token,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            certificate: encodeBase64url(cert.certificateBytes),
            cert_sig: encodeBase64url(cert.certSig),
            pop: encodeBase64url(new Uint8Array(64)),
          }),
        }
      );
      expect(replay.status).toBe(400);
    } finally {
      close();
    }
  });
});
