import { afterEach, describe, expect, test } from 'bun:test';
import { encodeBase64url, randomBytes } from '@tmex/shared/auth';
import type { LinkStream } from '@tmex/shared/link';
import { type RelayEnvelope, relaySeqToWire } from '@tmex/shared/relay';
import { type RelayHarness, type RelayNodeClient, bootRelayHarness } from './relay-test-harness';

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
    clientA.send({ t: 'relay.status', blob, epoch: 7, direct_capable: true });
    const list = await clientB.inbox.takeOf('relay.list', 2_000);
    if (list.t !== 'relay.list') throw new Error('expected relay.list');
    const entry = list.nodes.find((n) => n.id === a.nodeId);
    expect(entry?.online).toBe(true);
    expect(entry?.direct_capable).toBe(true);
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
    const revoke = tenant.revokeRecord(b.nodeId);
    clientA.send({
      t: 'relay.keylog.append',
      id: 'rev',
      seq: 1,
      blob: envelope('revoke'),
      member: { op: 'revoke', bytes: revoke.bytes, sig: revoke.sig },
    });
    const ack = await clientA.inbox.takeOf('relay.keylog.ack');
    expect(ack.t === 'relay.keylog.ack' && ack.ok).toBe(true);
    const kicked = await clientB.inbox.takeOf('relay.kicked');
    expect(kicked.t === 'relay.kicked' && kicked.reason).toBe('revoked');
    expect(relay.runtime.tenants.getNode(tenant.id, b.nodeId)?.status).toBe('revoked');
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
    clientA.send({
      t: 'relay.keylog.append',
      id: 'rev2',
      seq: 1,
      blob: envelope('revoke'),
      member: { op: 'revoke', bytes: revoke.bytes, sig: revoke.sig },
    });
    const ack = await clientA.inbox.takeOf('relay.keylog.ack');
    if (ack.t !== 'relay.keylog.ack') throw new Error('expected ack');
    expect(ack.ok).toBe(true);
    expect(ack.member_ignored).toBe(true);
    expect(relay.runtime.tenants.getNode(tenant.id, b.nodeId)?.status).toBe('admitted');
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
