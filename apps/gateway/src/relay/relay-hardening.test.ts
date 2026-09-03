import { afterEach, describe, expect, test } from 'bun:test';
import { encodeBase64url, randomBytes } from '@tmex/shared/auth';
import type { LinkStream } from '@tmex/shared/link';
import { RELAY_CTL_MAX_NODES } from '@tmex/shared/relay';
import { normalizeRelayQuota } from './relay-quota';
import {
  type RelayHarness,
  type RelayNodeFixture,
  type RelayTenantHandle,
  bootRelayHarness,
  enrollRelayRoot,
} from './relay-test-harness';
import { RELAY_MAX_UNUSED_ENROLLMENTS } from './types';

let harness: RelayHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function boot(opts?: Parameters<typeof bootRelayHarness>[0]): Promise<RelayHarness> {
  harness = await bootRelayHarness(opts);
  return harness;
}

async function admittedPair(
  tenant: RelayTenantHandle
): Promise<{ a: RelayNodeFixture; b: RelayNodeFixture }> {
  return { a: tenant.addNode(), b: tenant.addNode() };
}

describe('relay token reissue', () => {
  test('重新 enroll 后旧令牌链路被踢，且旧链路的后续消息不再被处理', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    const client = await tenant.connect(node);
    await client.inbox.takeOf('auth.ok');

    const reissued = await enrollRelayRoot(relay, tenant.root);
    expect(reissued.tenant_id).toBe(tenant.id);
    expect(reissued.token).not.toBe(tenant.token);
    const kicked = await client.inbox.takeOf('relay.kicked');
    expect(kicked.t === 'relay.kicked' && kicked.reason).toBe('kicked');
    const info = await client.link.closed;
    expect(info.reason).toBe('relay-kicked');
  });

  test('认证后的每条消息都复查令牌：库里换了哈希就踢', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const client = await tenant.connect(tenant.addNode());
    await client.inbox.takeOf('auth.ok');
    // 绕过 enforceTokenReissue 直接改库，模拟「链路没被立刻踢掉」的窗口
    relay.runtime.tenants.reissueToken({
      tenantId: tenant.id,
      tokenHash: 'f'.repeat(64),
      tokenEpoch: 0,
      now: relay.now(),
    });
    client.send({ t: 'ping' });
    const kicked = await client.inbox.takeOf('relay.kicked');
    expect(kicked.t === 'relay.kicked' && kicked.reason).toBe('kicked');
  });

  test('重新 enroll 不动 root_epoch（enroll 里的 epoch 是未鉴权的自称值）', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const client = await tenant.connect(tenant.addNode());
    await client.inbox.takeOf('auth.ok');
    const rotate = tenant.rotateRootRecord();
    await tenant.appendMember(client, 'rotate-root', rotate);
    rotate.apply();
    expect(relay.runtime.tenants.get(tenant.id)?.rootEpoch).toBe(1);
    await enrollRelayRoot(relay, tenant.root, { rootEpoch: 99 });
    expect(relay.runtime.tenants.get(tenant.id)?.rootEpoch).toBe(1);
  });
});

describe('relay enroll.create 校验', () => {
  test('exp 不得超过 authorization 自身的到期', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const owner = tenant.addNode();
    const client = await tenant.connect(owner);
    await client.inbox.takeOf('auth.ok');
    const joiner = tenant.addNode();
    client.send({
      t: 'relay.enroll.create',
      id: 'too-long',
      enroll_pk: encodeBase64url(joiner.enroll.publicKey),
      authorization: encodeBase64url(joiner.authorizationBytes),
      authorization_sig: encodeBase64url(joiner.authorizationSig),
      // authorization.exp 是 now + 600_000
      exp: relay.now() + 900_000,
    });
    const ack = await client.inbox.takeOf('relay.enroll.ack');
    if (ack.t !== 'relay.enroll.ack') throw new Error('expected ack');
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('BAD_EXPIRY');
  });

  test('authorization 的 root_epoch 必须等于租户当前 epoch', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const owner = tenant.addNode();
    const client = await tenant.connect(owner);
    await client.inbox.takeOf('auth.ok');
    const staleJoiner = tenant.addNode();
    const rotate = tenant.rotateRootRecord();
    await tenant.appendMember(client, 'rotate-root', rotate);
    rotate.apply();
    client.send({
      t: 'relay.enroll.create',
      id: 'stale-epoch',
      enroll_pk: encodeBase64url(staleJoiner.enroll.publicKey),
      authorization: encodeBase64url(staleJoiner.authorizationBytes),
      authorization_sig: encodeBase64url(staleJoiner.authorizationSig),
      exp: relay.now() + 300_000,
    });
    const ack = await client.inbox.takeOf('relay.enroll.ack');
    if (ack.t !== 'relay.enroll.ack') throw new Error('expected ack');
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('ROOT_EPOCH_MISMATCH');
  });

  test('未使用的 enrollment 有每租户上限，过期行随清扫删除', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const owner = tenant.addNode();
    const client = await tenant.connect(owner);
    await client.inbox.takeOf('auth.ok');
    for (let i = 0; i < RELAY_MAX_UNUSED_ENROLLMENTS; i++) {
      relay.runtime.tenants.createEnrollment({
        id: `seed-${i}`,
        tenantId: tenant.id,
        enrollPk: randomBytes(32),
        authorizationBytes: new Uint8Array(8),
        authorizationSig: new Uint8Array(64),
        expiresAt: relay.now() + 600_000,
        now: relay.now(),
      });
    }
    const joiner = tenant.addNode();
    client.send({
      t: 'relay.enroll.create',
      id: 'over-quota',
      enroll_pk: encodeBase64url(joiner.enroll.publicKey),
      authorization: encodeBase64url(joiner.authorizationBytes),
      authorization_sig: encodeBase64url(joiner.authorizationSig),
      exp: relay.now() + 300_000,
    });
    const ack = await client.inbox.takeOf('relay.enroll.ack');
    if (ack.t !== 'relay.enroll.ack') throw new Error('expected ack');
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('ENROLLMENT_QUOTA');

    relay.advance(700_000);
    relay.runtime.uplink.sweepEnrollments();
    expect(relay.runtime.tenants.countUnusedEnrollments(tenant.id, relay.now())).toBe(0);
    expect(relay.runtime.tenants.getEnrollmentById('seed-0')).toBeNull();
  });

  test('创建频率闸：窗口内超量直接拒', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const owner = tenant.addNode();
    const client = await tenant.connect(owner);
    await client.inbox.takeOf('auth.ok');
    let limited = 0;
    for (let i = 0; i < 20; i++) {
      const joiner = tenant.addNode();
      client.send({
        t: 'relay.enroll.create',
        id: `rate-${i}`,
        enroll_pk: encodeBase64url(joiner.enroll.publicKey),
        authorization: encodeBase64url(joiner.authorizationBytes),
        authorization_sig: encodeBase64url(joiner.authorizationSig),
        exp: relay.now() + 300_000,
      });
      const ack = await client.inbox.takeOf('relay.enroll.ack');
      if (ack.t === 'relay.enroll.ack' && ack.error === 'ENROLLMENT_RATE_LIMITED') limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

describe('relay stream quota', () => {
  test('并发打开的流共用同一份租户额度（先占位再 await）', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const { a, b } = await admittedPair(tenant);
    const clientA = await tenant.connect(a);
    await clientA.inbox.takeOf('auth.ok');
    const clientB = await tenant.connect(b);
    await clientB.inbox.takeOf('auth.ok');
    clientB.onStream((stream) => {
      void stream.readable.getReader().read();
    });
    const patched = await relay.adminFetch(`/api/relay/tenants/${tenant.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        quota: { maxNodes: 8, maxStreams: 2, bandwidthBytesPerSec: null },
      }),
    });
    expect(patched.status).toBe(200);

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => openAndSettle(clientA.openRelay(b.nodeId)))
    );
    const rejected = results.filter(
      (item) => item.status === 'fulfilled' && item.value === 'rejected'
    ).length;
    expect(relay.runtime.registry.streamCount(tenant.id)).toBeLessThanOrEqual(2);
    expect(rejected).toBeGreaterThanOrEqual(4);
  });
});

async function openAndSettle(pending: Promise<LinkStream>): Promise<'open' | 'rejected'> {
  let stream: LinkStream;
  try {
    stream = await pending;
  } catch {
    return 'rejected';
  }
  return new Promise<'open' | 'rejected'>((resolve) => {
    let done = false;
    stream.onAbort(() => {
      if (!done) {
        done = true;
        resolve('rejected');
      }
    });
    setTimeout(() => {
      if (!done) {
        done = true;
        resolve('open');
      }
    }, 60);
  });
}

describe('relay list capacity', () => {
  test('先滤 revoked 再截断：活着的节点不会被吊销行挤出清单', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    for (let i = 0; i < RELAY_CTL_MAX_NODES + 8; i++) {
      relay.runtime.tenants.upsertNode({
        tenantId: tenant.id,
        nodeId: `${i.toString(16).padStart(4, '0')}${'0'.repeat(28)}`,
        edPk: randomBytes(32),
        x25519Pk: randomBytes(32),
        status: 'revoked',
        now: relay.now(),
      });
    }
    const client = await tenant.connect(node);
    const list = await client.inbox.takeOf('relay.list', 2_000);
    if (list.t !== 'relay.list') throw new Error('expected relay.list');
    expect(list.nodes.length).toBeLessThanOrEqual(RELAY_CTL_MAX_NODES);
    expect(list.nodes.some((row) => row.id === node.nodeId)).toBe(true);
    expect(list.nodes.every((row) => row.status !== 'revoked')).toBe(true);
  });

  test('maxNodes 配额被清单容量封顶', () => {
    expect(
      normalizeRelayQuota({
        maxNodes: RELAY_CTL_MAX_NODES,
        maxStreams: 8,
        bandwidthBytesPerSec: null,
      })
    ).not.toBeNull();
    expect(
      normalizeRelayQuota({
        maxNodes: RELAY_CTL_MAX_NODES + 1,
        maxStreams: 8,
        bandwidthBytesPerSec: null,
      })
    ).toBeNull();
  });
});
