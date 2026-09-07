import { afterEach, describe, expect, test } from 'bun:test';
import { encodeBase64url, randomBytes } from '@vibeterm/shared/auth';
import type { LinkStream } from '@vibeterm/shared/link';
import { RELAY_CTL_MAX_NODES } from '@vibeterm/shared/relay';
import { sha256Hex } from './relay-password';
import { normalizeRelayQuota } from './relay-quota';
import {
  type RelayHarness,
  type RelayNodeFixture,
  type RelayTenantHandle,
  bootRelayHarness,
  enrollRelayRoot,
} from './relay-test-harness';
import { RELAY_MAX_UNUSED_ENROLLMENTS, RELAY_PREV_TOKEN_GRACE_MS } from './types';

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
  test('拿不出当前令牌重新 enroll：换发但保留上一代，在线成员不掉线', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    const client = await tenant.connect(node);
    expect(await client.inbox.takeOf('auth.ok')).toMatchObject({ token_rotated: false });

    const reissued = await enrollRelayRoot(relay, tenant.root);
    expect(reissued.tenant_id).toBe(tenant.id);
    expect(reissued.token).not.toBe(tenant.token);
    expect(relay.runtime.tenants.get(tenant.id)?.prevTokenHash).toBeTruthy();

    // 新令牌还在密钥日志里没送到成员手上，旧链路必须继续活着
    client.send({ t: 'ping' });
    expect((await client.inbox.takeOf('pong')).t).toBe('pong');
  });

  test('三次换发仍允许最初令牌重新连接与开流，第四次淘汰最老代', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const firstHash = sha256Hex(tenant.token);
    const node = tenant.addNode();
    const peerNode = tenant.addNode();
    for (let i = 0; i < 3; i++) {
      relay.advance(1_000);
      await enrollRelayRoot(relay, tenant.root);
    }
    const ring = relay.runtime.tenants.get(tenant.id)?.previousTokens;
    expect(ring?.length).toBe(3);
    expect(ring?.[2]?.hash).toBe(firstHash);
    expect(ring?.map((entry) => entry.issued_at)).toEqual([
      relay.now(),
      relay.now() - 1_000,
      relay.now() - 2_000,
    ]);
    const client = await tenant.connect(node);
    expect(await client.inbox.takeOf('auth.ok')).toMatchObject({ token_rotated: true });
    const peer = await tenant.connect(peerNode);
    expect(await peer.inbox.takeOf('auth.ok')).toMatchObject({ token_rotated: true });
    peer.onStream(() => {});
    const stream = await client.openRelay(peerNode.nodeId);
    await stream.write(new Uint8Array([1]));
    client.send({ t: 'ping' });
    expect((await client.inbox.takeOf('pong')).t).toBe('pong');
    await enrollRelayRoot(relay, tenant.root);
    expect(
      relay.runtime.tenants
        .get(tenant.id)
        ?.previousTokens?.some((entry) => entry.hash === firstHash)
    ).toBe(false);
    client.send({ t: 'ping' });
    const kicked = await client.inbox.takeOf('relay.kicked');
    expect(kicked.t === 'relay.kicked' && kicked.reason).toBe('kicked');
  });

  test('出示当前令牌重新 enroll：令牌不换发', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const before = relay.runtime.tenants.get(tenant.id)?.tokenHash;
    const again = await enrollRelayRoot(relay, tenant.root, {
      knownTokenHash: sha256Hex(tenant.token),
    });
    expect(again.tenant_id).toBe(tenant.id);
    expect(again.token).toBeNull();
    expect(again.token_unchanged).toBe(true);
    expect(relay.runtime.tenants.get(tenant.id)?.tokenHash).toBe(before ?? '');
    expect(relay.runtime.tenants.get(tenant.id)?.prevTokenHash).toBeNull();
  });

  test('手持上一代令牌重新 enroll 必换发：不会把将过期的旧令牌再写回去', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const stale = tenant.token;
    const rotated = await enrollRelayRoot(relay, tenant.root);
    if (!rotated.token) throw new Error('expected a rotated token');
    // 拿旧令牌哈希再来一次：必须换发新令牌，而不是回 token_unchanged
    const again = await enrollRelayRoot(relay, tenant.root, {
      knownTokenHash: sha256Hex(stale),
    });
    expect(again.token_unchanged).toBe(false);
    expect(again.token).toBeTruthy();
    expect(again.token).not.toBe(rotated.token);
    expect(relay.runtime.tenants.get(tenant.id)?.prevTokenHash).toBe(sha256Hex(rotated.token));
  });

  test('只跑数据流的链路在宽限到期后被心跳那一拍收掉', async () => {
    const relay = await boot({ heartbeatIntervalMs: 5, heartbeatMissLimit: 1_000 });
    const tenant = await relay.createTenant();
    const { a, b } = await admittedPair(tenant);
    const stale = tenant.token;
    await enrollRelayRoot(relay, tenant.root);

    // a 拿上一代令牌接进来，之后只开流、不发任何 ctl
    const client = await tenant.connect(a, { token: stale });
    await client.inbox.takeOf('auth.ok');
    const peer = await tenant.connect(b);
    await peer.inbox.takeOf('auth.ok');
    peer.onStream(() => {});
    const stream = await client.openRelay(b.nodeId);
    await stream.write(new Uint8Array([1]));

    relay.advance(RELAY_PREV_TOKEN_GRACE_MS + 1);
    const kicked = await client.inbox.takeOf('relay.kicked', 4_000);
    expect(kicked.t === 'relay.kicked' && kicked.reason).toBe('kicked');
    expect((await client.link.closed).reason).toBe('relay-kicked');
  });

  test('历史令牌宽限到期后，新开流触发准入复查', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const client = await tenant.connect(tenant.addNode());
    await client.inbox.takeOf('auth.ok');
    const rotated = await enrollRelayRoot(relay, tenant.root);
    if (!rotated.token) throw new Error('expected rotated token');
    const peerNode = tenant.addNode();
    const peer = await tenant.connect(peerNode, { token: rotated.token });
    await peer.inbox.takeOf('auth.ok');
    peer.onStream(() => {});
    relay.advance(RELAY_PREV_TOKEN_GRACE_MS + 1);
    const opening = openAndSettle(client.openRelay(peerNode.nodeId));
    const kicked = await client.inbox.takeOf('relay.kicked');
    expect(kicked.t === 'relay.kicked' && kicked.reason).toBe('kicked');
    expect(await opening).toBe('rejected');
  });

  test('宽限期内上一代令牌仍可认证，kick 模式改密后立刻失效', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    const stale = tenant.token;
    await enrollRelayRoot(relay, tenant.root);

    const first = await tenant.connect(node, { token: stale });
    expect((await first.inbox.takeOf('auth.ok')).t).toBe('auth.ok');
    first.link.close('done');

    const rotated = await relay.adminFetch('/api/relay/password', {
      method: 'POST',
      body: JSON.stringify({ password: 'kick-pass', mode: 'kick', force: true }),
    });
    expect(rotated.status).toBe(200);
    expect(relay.runtime.tenants.get(tenant.id)?.prevTokenHash).toBeNull();
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
      keepPrevious: false,
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
    const readers: ReadableStreamDefaultReader[] = [];
    clientB.onStream((stream) => {
      const reader = stream.readable.getReader();
      readers.push(reader);
      void reader.read().catch(() => undefined);
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
    await Promise.all(readers.map((reader) => reader.cancel().catch(() => undefined)));
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
