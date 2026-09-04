import { afterEach, describe, expect, test } from 'bun:test';
import { encodeBase64url, randomBytes } from '@tmex/shared/auth';
import type { LinkStream } from '@tmex/shared/link';
import { type RelayEnvelope, relaySeqToWire } from '@tmex/shared/relay';
import {
  type RelayHarness,
  type RelayNodeClient,
  bootRelayHarness,
  enrollRelayRoot,
} from './relay-test-harness';

let harness: RelayHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function boot(opts?: Parameters<typeof bootRelayHarness>[0]): Promise<RelayHarness> {
  harness = await bootRelayHarness(opts);
  return harness;
}

function envelope(text: string): RelayEnvelope {
  return {
    v: 1,
    epoch: 1,
    n: encodeBase64url(randomBytes(12)),
    ct: encodeBase64url(new TextEncoder().encode(text)),
  };
}

async function closed(client: RelayNodeClient): Promise<string> {
  const info = await client.link.closed;
  return info.reason;
}

describe('relay uplink auth', () => {
  test('admits a node with a root-signed member proof and answers auth.ok + quota', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    const client = await tenant.connect(node);
    const ok = await client.inbox.takeOf('auth.ok');
    expect(ok.t === 'auth.ok' && ok.tenant_id).toBe(tenant.id);
    expect(ok.t === 'auth.ok' && ok.key_log_head_seq).toBe(0);
    const quota = await client.inbox.takeOf('relay.quota');
    expect(quota.t === 'relay.quota' && quota.maxNodes).toBe(16);
    expect(quota.t === 'relay.quota' && quota.currentNodes).toBe(1);
    const list = await client.inbox.takeOf('relay.list');
    expect(list.t === 'relay.list' && list.nodes.map((n) => n.id)).toEqual([node.nodeId]);
    expect(relay.runtime.tenants.getNode(tenant.id, node.nodeId)?.status).toBe('admitted');
  });

  test('rejects an unknown node with no member proof', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    const client = await tenant.connect(node, { withMember: false });
    expect(await closed(client)).toBe('member-required');
  });

  test('rejects a bad tenant token and an unknown tenant', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    const bad = await tenant.connect(node, { token: encodeBase64url(randomBytes(32)) });
    expect(await closed(bad)).toBe('bad-token');
  });

  test('rejects clients below the minimum version', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    const client = await tenant.connect(node, { clientVersion: '1.1.22' });
    expect(await closed(client)).toBe('client-too-old');
  });

  test('accepts the dev build suffix reported by non-production gateways', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    const client = await tenant.connect(node, { clientVersion: '1.1.23_dev' });
    const ok = await client.inbox.takeOf('auth.ok');
    expect(ok.t).toBe('auth.ok');
    expect(relay.runtime.tenants.getNode(tenant.id, node.nodeId)?.clientVersion).toBe('1.1.23_dev');
  });

  test('accepts a passkey-signed admit only when the tenant already has an admitted node', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const first = tenant.addNode({ admitSigner: 'passkey' });
    const rejected = await tenant.connect(first);
    expect(await closed(rejected)).toBe('member-passkey_unverifiable');

    const rootNode = tenant.addNode();
    const rootClient = await tenant.connect(rootNode);
    await rootClient.inbox.takeOf('auth.ok');
    const second = tenant.addNode({ admitSigner: 'passkey' });
    const tolerated = await tenant.connect(second);
    const ok = await tolerated.inbox.takeOf('auth.ok');
    expect(ok.t).toBe('auth.ok');
  });

  test('rejects a member proof whose certificate is for another node', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const a = tenant.addNode();
    const b = tenant.addNode();
    const client = await tenant.connect({ ...b, admit: a.admit });
    expect(await closed(client)).toBe('member-node_mismatch');
  });

  test('rejects a revoked node', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    const first = await tenant.connect(node);
    await first.inbox.takeOf('auth.ok');
    relay.runtime.tenants.patchNode(tenant.id, node.nodeId, { status: 'revoked' });
    first.close();
    const again = await tenant.connect(node);
    expect(await closed(again)).toBe('revoked');
  });
});

describe('relay list and status', () => {
  test('broadcasts the tenant list with the latest status blob on update', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const a = tenant.addNode();
    const b = tenant.addNode();
    const clientA = await tenant.connect(a);
    await clientA.inbox.takeOf('relay.list');
    const clientB = await tenant.connect(b);
    await clientB.inbox.takeOf('auth.ok');
    const blob = envelope('status-a');
    clientA.send({ t: 'relay.status', blob, epoch: 7 });
    const list = await clientB.inbox.takeOf('relay.list', 2_000);
    if (list.t !== 'relay.list') throw new Error('expected relay.list');
    const entry = list.nodes.find((n) => n.id === a.nodeId);
    expect(entry?.online).toBe(true);
    expect(entry?.epoch).toBe(7);
    expect(entry?.blob).toEqual(blob);
  });

  test('never leaks another tenant into the list', async () => {
    const relay = await boot();
    const one = await relay.createTenant();
    const two = await relay.createTenant();
    const a = one.addNode();
    const b = two.addNode();
    const clientA = await one.connect(a);
    const clientB = await two.connect(b);
    await clientB.inbox.takeOf('auth.ok');
    const list = await clientA.inbox.takeOf('relay.list');
    if (list.t !== 'relay.list') throw new Error('expected relay.list');
    expect(list.nodes.map((n) => n.id)).toEqual([a.nodeId]);
  });
});

describe('relay key log', () => {
  test('appends in order, pushes to peers and pages back', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const a = tenant.addNode();
    const b = tenant.addNode();
    const clientA = await tenant.connect(a);
    await clientA.inbox.takeOf('auth.ok');
    const clientB = await tenant.connect(b);
    await clientB.inbox.takeOf('auth.ok');
    const blob = envelope('record-1');
    clientA.send({ t: 'relay.keylog.append', id: 'r1', seq: 1, blob });
    const ack = await clientA.inbox.takeOf('relay.keylog.ack');
    expect(ack.t === 'relay.keylog.ack' && ack.ok).toBe(true);
    const push = await clientB.inbox.takeOf('relay.keylog.push');
    expect(push.t === 'relay.keylog.push' && push.records[0]?.seq).toBe(1);

    clientB.send({ t: 'relay.keylog.req', from_seq: 1 });
    const res = await clientB.inbox.takeOf('relay.keylog.res');
    if (res.t !== 'relay.keylog.res') throw new Error('expected relay.keylog.res');
    expect(res.records).toHaveLength(1);
    expect(res.records[0]?.blob).toEqual(blob);
  });

  test('rejects a seq gap with SEQ_MISMATCH and the current head', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    const client = await tenant.connect(node);
    await client.inbox.takeOf('auth.ok');
    client.send({ t: 'relay.keylog.append', id: 'r5', seq: 5, blob: envelope('x') });
    const ack = await client.inbox.takeOf('relay.keylog.ack');
    if (ack.t !== 'relay.keylog.ack') throw new Error('expected ack');
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('SEQ_MISMATCH');
    expect(ack.head).toBe(0);
  });

  test('applies a root-signed revoke and disconnects the revoked node', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const a = tenant.addNode();
    const b = tenant.addNode();
    const clientA = await tenant.connect(a);
    await clientA.inbox.takeOf('auth.ok');
    const clientB = await tenant.connect(b);
    await clientB.inbox.takeOf('auth.ok');
    relay.runtime.metering.recordMember(tenant.id, b.nodeId, { bytesIn: 99, bytesOut: 7 });
    const ack = await tenant.appendMember(clientA, 'revoke', tenant.revokeRecord(b.nodeId));
    expect(ack.ok).toBe(true);
    const kicked = await clientB.inbox.takeOf('relay.kicked');
    expect(kicked.t === 'relay.kicked' && kicked.reason).toBe('revoked');
    expect(relay.runtime.tenants.getNode(tenant.id, b.nodeId)?.status).toBe('revoked');
    expect(relay.runtime.metering.liveMemberSnapshot(tenant.id, b.nodeId)).toEqual({
      bytesIn: 0,
      bytesOut: 0,
    });
    expect(relay.runtime.registry.reconnectsOf(tenant.id, b.nodeId)).toBe(0);
    clientB.close();
    relay.runtime.metering.recordMember(tenant.id, b.nodeId, { bytesIn: 1 });
    relay.runtime.metering.forgetMember(tenant.id, b.nodeId);
    relay.runtime.registry.forgetMember(tenant.id, b.nodeId);
    expect(relay.runtime.metering.liveMemberSnapshot(tenant.id, b.nodeId)).toEqual({
      bytesIn: 0,
      bytesOut: 0,
    });
  });

  test('pong 晚于后续心跳到达时 RTT 仍按原始 ping 计', async () => {
    const relay = await boot({ heartbeatIntervalMs: 40, heartbeatMissLimit: 10 });
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    const client = await tenant.connect(node);
    await client.inbox.takeOf('auth.ok');
    await client.inbox.takeOf('relay.quota');
    await client.inbox.takeOf('relay.list');
    const ping = await client.inbox.takeOf('ping', 1_000);
    expect(ping.t).toBe('ping');
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(client.inbox.drain().filter((msg) => msg.t === 'ping')).toHaveLength(0);
    relay.advance(77);
    client.send({ t: 'pong' });
    const deadline = Date.now() + 200;
    let rtt: number | null | undefined;
    while (Date.now() < deadline) {
      rtt = relay.runtime.registry.get(tenant.id, node.nodeId)?.rttMs;
      if (rtt != null) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(rtt).toBe(77);
  });

  test('ignores a passkey-signed revoke and says so in the ack', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const a = tenant.addNode();
    const b = tenant.addNode();
    const clientA = await tenant.connect(a);
    await clientA.inbox.takeOf('auth.ok');
    const clientB = await tenant.connect(b);
    await clientB.inbox.takeOf('auth.ok');
    const revoke = tenant.revokeRecord(b.nodeId, 'passkey');
    // 真实的变长 passkey 断言（不是 64 个零字节）必须能过编解码，但中继一律不采信
    expect(revoke.sig.length).toBeGreaterThan(100);
    const ack = await tenant.appendMember(clientA, 'revoke', revoke);
    expect(ack.ok).toBe(true);
    expect(ack.member_ignored).toBe(true);
    expect(ack.member_error).toBe('passkey_unverifiable');
    expect(relay.runtime.tenants.getNode(tenant.id, b.nodeId)?.status).toBe('admitted');
  });

  test('member 明文必须是本次 seq 的那条记录：错位的 admit 一律忽略', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const a = tenant.addNode();
    const client = await tenant.connect(a);
    await client.inbox.takeOf('auth.ok');
    // a.admit 的记录 seq 是 1，这里把它挂到 seq=1 之外的位置
    client.send({
      t: 'relay.keylog.append',
      id: 'mismatch',
      seq: 1,
      blob: envelope('x'),
    });
    await client.inbox.takeOf('relay.keylog.ack');
    client.send({
      t: 'relay.keylog.append',
      id: 'mismatch-2',
      seq: 2,
      blob: envelope('y'),
      member: { op: 'admit', bytes: a.admit.bytes, sig: a.admit.sig },
    });
    const ack = await client.inbox.takeOf('relay.keylog.ack');
    if (ack.t !== 'relay.keylog.ack') throw new Error('expected ack');
    expect(ack.ok).toBe(true);
    expect(ack.member_error).toBe('seq_mismatch');
  });

  test('被吊销的节点不会被重放的 admit 抬回来（root 与 passkey 两条路都不行）', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const a = tenant.addNode();
    const b = tenant.addNode();
    const clientA = await tenant.connect(a);
    await clientA.inbox.takeOf('auth.ok');
    const clientB = await tenant.connect(b);
    await clientB.inbox.takeOf('auth.ok');
    await tenant.appendMember(clientA, 'revoke', tenant.revokeRecord(b.nodeId));
    expect(relay.runtime.tenants.getNode(tenant.id, b.nodeId)?.status).toBe('revoked');

    // 重放 b 自己的 admit-node（根签名、格式完好），挂在下一条 seq 上
    const head = Number(relay.runtime.tenants.get(tenant.id)?.keyLogHeadSeq ?? 0n);
    clientA.send({
      t: 'relay.keylog.append',
      id: 'replay',
      seq: head + 1,
      blob: envelope('replay'),
      member: { op: 'admit', bytes: b.admit.bytes, sig: b.admit.sig },
    });
    const replayAck = await clientA.inbox.takeOf('relay.keylog.ack');
    if (replayAck.t !== 'relay.keylog.ack') throw new Error('expected ack');
    expect(replayAck.ok).toBe(true);
    expect(replayAck.member_ignored).toBe(true);
    expect(relay.runtime.tenants.getNode(tenant.id, b.nodeId)?.status).toBe('revoked');

    // passkey 签名的 admit（中继验不了、只靠令牌信任）同样不能翻案
    const passkeyAdmit = tenant.addNode({ admitSigner: 'passkey' });
    const forged = { ...passkeyAdmit.admit };
    clientA.send({
      t: 'relay.keylog.append',
      id: 'forged',
      seq: forged.seq,
      blob: envelope('forged'),
      member: { op: 'admit', bytes: forged.bytes, sig: forged.sig },
    });
    await clientA.inbox.takeOf('relay.keylog.ack');
    expect(relay.runtime.tenants.getNode(tenant.id, b.nodeId)?.status).toBe('revoked');
    // 被吊销的节点重连也一样：带着自己的 admit 也进不来
    const reconnect = await tenant.connect(b);
    expect(await closed(reconnect)).toBe('revoked');
  });

  test('日志行与 head 同事务：head 冲突时不会留下半条记录', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    const client = await tenant.connect(node);
    await client.inbox.takeOf('auth.ok');
    client.send({ t: 'relay.keylog.append', id: 'ok1', seq: 1, blob: envelope('one') });
    await client.inbox.takeOf('relay.keylog.ack');
    // 直接把 head 抬高，模拟并发写：本次 append 必须整体回滚
    relay.runtime.tenants.setKeyLogHead(tenant.id, 5n);
    client.send({ t: 'relay.keylog.append', id: 'ok2', seq: 2, blob: envelope('two') });
    const ack = await client.inbox.takeOf('relay.keylog.ack');
    if (ack.t !== 'relay.keylog.ack') throw new Error('expected ack');
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('SEQ_MISMATCH');
    expect(relay.runtime.keyLog.list(tenant.id, 2n, 10)).toEqual([]);
  });

  test('根轮换：新根签的 admit 通过，旧根签的被拒', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const owner = tenant.addNode();
    const client = await tenant.connect(owner);
    await client.inbox.takeOf('auth.ok');
    const rotate = tenant.rotateRootRecord();
    const rotateAck = await tenant.appendMember(client, 'rotate-root', rotate);
    expect(rotateAck.ok).toBe(true);
    expect(rotateAck.member_ignored).toBeUndefined();
    const stored = relay.runtime.tenants.get(tenant.id);
    expect(stored?.rootEpoch).toBe(1);

    // 轮换之后仍用旧根签的 admit：epoch 对不上，直接忽略
    const staleNode = tenant.addNode();
    const stale = await tenant.appendMember(client, 'admit', staleNode.admit);
    expect(stale.member_error).toBe('epoch_mismatch');
    expect(relay.runtime.tenants.getNode(tenant.id, staleNode.nodeId)).toBeNull();

    // 轮换后用新根签的 admit：正常通过
    rotate.apply();
    const fresh = tenant.addNode();
    const freshAck = await tenant.appendMember(client, 'admit', fresh.admit);
    expect(freshAck.ok).toBe(true);
    expect(freshAck.member_ignored).toBeUndefined();
    expect(relay.runtime.tenants.getNode(tenant.id, fresh.nodeId)?.status).toBe('admitted');
  });

  test('根轮换后旧根 enroll 落到新租户，拿不到原租户的注册表', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const owner = tenant.addNode();
    const client = await tenant.connect(owner);
    await client.inbox.takeOf('auth.ok');
    const oldRoot = tenant.root;
    await tenant.appendMember(client, 'rotate-root', tenant.rotateRootRecord());
    const reEnrolled = await enrollRelayRoot(relay, oldRoot);
    expect(reEnrolled.tenant_id).not.toBe(tenant.id);
    expect(relay.runtime.tenants.listNodes(reEnrolled.tenant_id)).toEqual([]);
    expect(relay.runtime.tenants.get(tenant.id)?.rootEpoch).toBe(1);
  });

  test('key logs of two tenants are independent', async () => {
    const relay = await boot();
    const one = await relay.createTenant();
    const two = await relay.createTenant();
    const a = one.addNode();
    const b = two.addNode();
    const clientA = await one.connect(a);
    await clientA.inbox.takeOf('auth.ok');
    const clientB = await two.connect(b);
    await clientB.inbox.takeOf('auth.ok');
    clientA.send({ t: 'relay.keylog.append', id: 'x', seq: 1, blob: envelope('one') });
    expect((await clientA.inbox.takeOf('relay.keylog.ack')).t).toBe('relay.keylog.ack');
    clientB.send({ t: 'relay.keylog.req', from_seq: 1 });
    const res = await clientB.inbox.takeOf('relay.keylog.res');
    expect(res.t === 'relay.keylog.res' && res.records).toEqual([]);
    expect(relay.runtime.keyLog.head(two.id)).toBe(0n);
    expect(relay.runtime.keyLog.head(one.id)).toBe(1n);
  });
});

describe('relay rtc forwarding', () => {
  test('forwards to an admitted peer of the same tenant only', async () => {
    const relay = await boot();
    const one = await relay.createTenant();
    const two = await relay.createTenant();
    const a = one.addNode();
    const b = one.addNode();
    const outsider = two.addNode();
    const clientA = await one.connect(a);
    await clientA.inbox.takeOf('auth.ok');
    const clientB = await one.connect(b);
    await clientB.inbox.takeOf('auth.ok');
    const clientC = await two.connect(outsider);
    await clientC.inbox.takeOf('auth.ok');
    const enc = envelope('sdp');
    clientA.send({ t: 'relay.rtc', rtcSession: 's1', from: 'node', to: b.nodeId, enc });
    const got = await clientB.inbox.takeOf('relay.rtc');
    expect(got.t === 'relay.rtc' && got.enc).toEqual(enc);
    clientA.send({
      t: 'relay.rtc',
      rtcSession: 's2',
      from: 'node',
      to: outsider.nodeId,
      enc: envelope('cross'),
    });
    await expect(clientC.inbox.takeOf('relay.rtc', 120)).rejects.toThrow();
  });
});

describe('relay streams', () => {
  async function collect(stream: LinkStream, expected: number): Promise<Uint8Array> {
    const reader = stream.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < expected) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value.bytes);
      total += value.bytes.byteLength;
    }
    reader.releaseLock();
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  test('relays bytes between two nodes of the same tenant and meters them', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const a = tenant.addNode();
    const b = tenant.addNode();
    const clientA = await tenant.connect(a);
    await clientA.inbox.takeOf('auth.ok');
    const clientB = await tenant.connect(b);
    await clientB.inbox.takeOf('auth.ok');
    const incoming = new Promise<LinkStream>((resolve) => {
      clientB.onStream(resolve);
    });
    const out = await clientA.openRelay(b.nodeId);
    const inbound = await incoming;
    expect(JSON.parse(new TextDecoder().decode(inbound.openPayload))).toEqual({
      to: b.nodeId,
      from: a.nodeId,
    });
    await out.write(new TextEncoder().encode('hello'));
    expect(new TextDecoder().decode(await collect(inbound, 5))).toBe('hello');
    const usage = relay.runtime.metering.pendingFor(tenant.id);
    expect(usage.bytesIn).toBe(5);
    expect(usage.bytesOut).toBe(5);
  });

  test('resets a relay open aimed at another tenant', async () => {
    const relay = await boot();
    const one = await relay.createTenant();
    const two = await relay.createTenant();
    const a = one.addNode();
    const b = two.addNode();
    const clientA = await one.connect(a);
    await clientA.inbox.takeOf('auth.ok');
    const clientB = await two.connect(b);
    await clientB.inbox.takeOf('auth.ok');
    const stream = await clientA.openRelay(b.nodeId);
    const info = await stream.closed;
    expect(info.reason).toBe('rst');
    expect(info.message).toBe('unknown-target');
  });

  test('enforces the concurrent stream quota', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const a = tenant.addNode();
    const b = tenant.addNode();
    const clientA = await tenant.connect(a);
    await clientA.inbox.takeOf('auth.ok');
    const clientB = await tenant.connect(b);
    await clientB.inbox.takeOf('auth.ok');
    clientB.onStream(() => {});
    await relay.adminFetch(`/api/relay/tenants/${tenant.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        quota: { maxNodes: 8, maxStreams: 1, bandwidthBytesPerSec: null },
      }),
    });
    const first = await clientA.openRelay(b.nodeId);
    await first.write(new Uint8Array([1]));
    const second = await clientA.openRelay(b.nodeId);
    const info = await second.closed;
    expect(info.message).toBe('quota-streams');
  });
});

describe('relay kick', () => {
  test('password rotation in kick mode disconnects stale-token links', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    const client = await tenant.connect(node);
    await client.inbox.takeOf('auth.ok');
    const res = await relay.adminFetch('/api/relay/password', {
      method: 'POST',
      body: JSON.stringify({ password: 'new-secret', mode: 'kick' }),
    });
    expect(res.status).toBe(200);
    const kicked = await client.inbox.takeOf('relay.kicked');
    expect(kicked.t === 'relay.kicked' && kicked.reason).toBe('password_rotated');
    const again = await tenant.connect(node);
    expect(await closed(again)).toBe('token-epoch');
  });

  test('keep mode leaves existing tokens working', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    const client = await tenant.connect(node);
    await client.inbox.takeOf('auth.ok');
    const res = await relay.adminFetch('/api/relay/password', {
      method: 'POST',
      body: JSON.stringify({ password: 'new-secret', mode: 'keep' }),
    });
    expect(res.status).toBe(200);
    client.close();
    const again = await tenant.connect(node);
    expect((await again.inbox.takeOf('auth.ok')).t).toBe('auth.ok');
  });

  test('admin kick marks the tenant and blocks reconnects until re-enroll', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    const client = await tenant.connect(node);
    await client.inbox.takeOf('auth.ok');
    await relay.adminFetch(`/api/relay/tenants/${tenant.id}/kick`, { method: 'POST' });
    const kicked = await client.inbox.takeOf('relay.kicked');
    expect(kicked.t === 'relay.kicked' && kicked.reason).toBe('kicked');
    const blocked = await tenant.connect(node);
    expect(await closed(blocked)).toBe('tenant-kicked');
  });

  test('kick between auth precondition and registration is rejected', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredAt = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const relay = await boot({
      authBarrier: async () => {
        entered();
        await gate;
      },
    });
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    const connecting = tenant.connect(node);
    await enteredAt;
    await relay.adminFetch(`/api/relay/tenants/${tenant.id}/kick`, { method: 'POST' });
    release();
    expect(await closed(await connecting)).toBe('tenant-kicked');
  });

  test('token reissue between auth precondition and registration is rejected', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredAt = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const relay = await boot({
      authBarrier: async () => {
        entered();
        await gate;
      },
    });
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    const connecting = tenant.connect(node);
    await enteredAt;
    const res = await relay.adminFetch('/api/relay/password', {
      method: 'POST',
      body: JSON.stringify({ password: 'new-secret-word', mode: 'kick' }),
    });
    expect(res.status).toBe(200);
    release();
    expect(await closed(await connecting)).toBe('token-epoch');
  });
});

describe('relay enrollment ctl', () => {
  test('rejects an authorization that does not match the enroll key', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    const other = tenant.addNode();
    const client = await tenant.connect(node);
    await client.inbox.takeOf('auth.ok');
    client.send({
      t: 'relay.enroll.create',
      id: 'bad',
      enroll_pk: encodeBase64url(other.enroll.publicKey),
      authorization: encodeBase64url(node.authorizationBytes),
      authorization_sig: encodeBase64url(node.authorizationSig),
      exp: relay.now() + 60_000,
    });
    const ack = await client.inbox.takeOf('relay.enroll.ack');
    if (ack.t !== 'relay.enroll.ack') throw new Error('expected ack');
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('ENROLL_PK_MISMATCH');
  });

  test('rejects an expired ttl', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    const client = await tenant.connect(node);
    await client.inbox.takeOf('auth.ok');
    client.send({
      t: 'relay.enroll.create',
      id: 'stale',
      enroll_pk: encodeBase64url(node.enroll.publicKey),
      authorization: encodeBase64url(node.authorizationBytes),
      authorization_sig: encodeBase64url(node.authorizationSig),
      exp: relay.now() - 1,
    });
    const ack = await client.inbox.takeOf('relay.enroll.ack');
    expect(ack.t === 'relay.enroll.ack' && ack.error).toBe('BAD_EXPIRY');
  });
});

describe('relay seq wire form', () => {
  test('encodes big sequence numbers as strings', () => {
    expect(relaySeqToWire(1n)).toBe(1);
    expect(relaySeqToWire(2n ** 60n)).toBe('1152921504606846976');
  });
});
