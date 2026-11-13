import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  buildKeyLogRecord,
  createNodeCertificate,
  encodeAdmitNodePayload,
  encodeBase64url,
  encodeKeyLogRecord,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  hexToBytes,
  randomBytes,
} from '@vibeterm/shared/auth';
import type { RelayCtlMessage, RelayEnvelope } from '@vibeterm/shared/relay';
import { signRelayKeyLogAppend } from './relay-append-proof';
import { sha256Hex } from './relay-password';
import {
  type RelayHarness,
  type RelayNodeClient,
  bootRelayHarness,
  enrollRelayRoot,
} from './relay-test-harness';
import type { RelayNodeFixture, RelayTenantHandle } from './relay-test-tenant';
import { relayCurrentTokenPredatesRevoke } from './relay-token-grace';
import { RELAY_JOIN_FOLLOWUP_WINDOW_MS } from './types';

let harness: RelayHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function boot(): Promise<RelayHarness> {
  harness = await bootRelayHarness();
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

type Ack = Extract<RelayCtlMessage, { t: 'relay.keylog.ack' }>;

async function append(
  client: RelayNodeClient,
  seq: number,
  member?: { op: 'admit' | 'revoke' | 'rotate-root'; bytes: string; sig: string }
): Promise<Ack> {
  client.send({
    t: 'relay.keylog.append',
    id: `a-${seq}-${Math.random()}`,
    seq,
    blob: envelope(`row-${seq}`),
    ...(member ? { member } : {}),
  });
  const ack = await client.inbox.takeOf('relay.keylog.ack');
  if (ack.t !== 'relay.keylog.ack') throw new Error('expected relay.keylog.ack');
  return ack;
}

async function connected(tenant: RelayTenantHandle, node: RelayNodeFixture) {
  const client = await tenant.connect(node);
  await client.inbox.takeOf('auth.ok');
  return client;
}

function postKeyLog(
  relay: RelayHarness,
  tenant: RelayTenantHandle,
  body: Record<string, unknown>,
  token = tenant.token
): Promise<Response> {
  return relay.tenantFetch(`/api/relay/tenants/${tenant.id}/keylog`, token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function headOf(relay: RelayHarness, tenant: RelayTenantHandle): number {
  return Number(relay.runtime.tenants.get(tenant.id)?.keyLogHeadSeq ?? 0n);
}

/** passkey 签名（sig 全零）的 admit-node：证书沿用已有 node_id，公钥换成另一对。 */
function passkeyAdmitForExisting(tenant: RelayTenantHandle, existingId: string, seq: number) {
  const enroll = generateEd25519KeyPair();
  const cert = createNodeCertificate(enroll.secretKey, {
    uid: tenant.uid,
    edPk: generateEd25519KeyPair().publicKey,
    x25519Pk: generateX25519KeyPair().publicKey,
    enrollPk: enroll.publicKey,
    now: Date.now(),
    nodeId: hexToBytes(existingId),
  });
  const record = buildKeyLogRecord(
    { seq: BigInt(seq - 1), hash: new Uint8Array(32) },
    tenant.rootEpoch(),
    {
      uid: tenant.uid,
      type: 'admit-node',
      payload: encodeAdmitNodePayload({
        authorization_bytes: new Uint8Array(8),
        authorization_sig: new Uint8Array(64),
        certificate_bytes: cert.certificateBytes,
        cert_sig: cert.certSig,
      }),
      signer: 'passkey',
      credential_id: 'unverified',
    }
  );
  return {
    op: 'admit' as const,
    bytes: encodeBase64url(encodeKeyLogRecord(record)),
    sig: encodeBase64url(new Uint8Array(70)),
  };
}

describe('中继注册表的节点公钥只在建行时写入', () => {
  test('passkey admit 不能改已准入节点的公钥', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const owner = tenant.addNode();
    const other = tenant.addNode();
    await connected(tenant, owner);
    const otherClient = await connected(tenant, other);
    const before = relay.runtime.tenants.getNode(tenant.id, owner.nodeId);
    const unadmitted = passkeyAdmitForExisting(tenant, owner.nodeId, headOf(relay, tenant) + 1);
    const ack = await append(otherClient, headOf(relay, tenant) + 1, unadmitted);
    expect(ack.ok).toBe(true);
    expect(ack.member_error).toBe('member_conflict');
    const after = relay.runtime.tenants.getNode(tenant.id, owner.nodeId);
    expect(after?.edPk).toEqual(before?.edPk ?? new Uint8Array());
    expect(after?.status).toBe('admitted');
    const reconnect = await tenant.connect(owner);
    const ok = await reconnect.inbox.takeOf('auth.ok');
    expect(ok.t).toBe('auth.ok');
  });

  test('store：同 node_id 换公钥回 conflict；同公钥只升不降；revoked 是终态', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const store = relay.runtime.tenants;
    const keys = { edPk: randomBytes(32), x25519Pk: randomBytes(32) };
    const nodeId = 'c'.repeat(32);
    const base = { tenantId: tenant.id, nodeId, now: relay.now() };
    expect(store.upsertNode({ ...base, ...keys, status: 'pending' }).outcome).toBe('created');
    const swapped = store.upsertNode({
      ...base,
      edPk: randomBytes(32),
      x25519Pk: keys.x25519Pk,
      status: 'admitted',
    });
    expect(swapped.outcome).toBe('conflict');
    expect(swapped.node.status).toBe('pending');
    expect(store.upsertNode({ ...base, ...keys, status: 'admitted' }).outcome).toBe('promoted');
    expect(store.upsertNode({ ...base, ...keys, status: 'pending' }).node.status).toBe('admitted');
    store.patchNode(tenant.id, nodeId, { status: 'revoked' });
    expect(store.upsertNode({ ...base, ...keys, status: 'admitted' }).outcome).toBe('revoked');
    expect(store.getNode(tenant.id, nodeId)?.edPk).toEqual(keys.edPk);
  });
});

describe('密钥日志追加必须可归属', () => {
  test('只凭租户令牌的 HTTP 追加被拒，日志不动', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    await connected(tenant, node);
    const res = await postKeyLog(relay, tenant, { seq: 1, blob: envelope('junk') });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'RELAY_APPEND_UNATTRIBUTED'
    );
    expect(headOf(relay, tenant)).toBe(0);
  });

  test('已准入节点签名的 HTTP 追加被接受并记下写入者；签名不对就拒', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    await connected(tenant, node);
    const blob = envelope('signed');
    const relayHost = relay.runtime.uplink.relayHost;
    const badSig = signRelayKeyLogAppend(node.ed.secretKey, {
      relayHost,
      tenantId: tenant.id,
      seq: 2n,
      envelope: blob,
    });
    const rejected = await postKeyLog(relay, tenant, {
      seq: 1,
      blob,
      node_id: node.nodeId,
      node_sig: encodeBase64url(badSig),
    });
    expect(rejected.status).toBe(403);
    const sig = signRelayKeyLogAppend(node.ed.secretKey, {
      relayHost,
      tenantId: tenant.id,
      seq: 1n,
      envelope: blob,
    });
    const res = await postKeyLog(relay, tenant, {
      seq: 1,
      blob,
      node_id: node.nodeId,
      node_sig: encodeBase64url(sig),
    });
    expect(res.status).toBe(200);
    expect(relay.runtime.keyLog.getMeta(tenant.id, 1n)?.appendedBy).toBe(node.nodeId);
  });

  test('uplink 追加记下链路节点；被吊销节点的令牌与签名都追加不进来', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const a = tenant.addNode();
    const b = tenant.addNode();
    const clientA = await connected(tenant, a);
    await connected(tenant, b);
    await tenant.appendMember(clientA, 'revoke', tenant.revokeRecord(b.nodeId));
    const head = headOf(relay, tenant);
    expect(relay.runtime.keyLog.getMeta(tenant.id, BigInt(head))?.rootOp).toBe('revoke');
    const blob = envelope('after-revoke');
    const sig = signRelayKeyLogAppend(b.ed.secretKey, {
      relayHost: relay.runtime.uplink.relayHost,
      tenantId: tenant.id,
      seq: BigInt(head + 1),
      envelope: blob,
    });
    const res = await postKeyLog(relay, tenant, {
      seq: head + 1,
      blob,
      node_id: b.nodeId,
      node_sig: encodeBase64url(sig),
    });
    expect(res.status).toBe(403);
    expect(headOf(relay, tenant)).toBe(head);
  });

  async function rootAdmitOverHttp(relay: RelayHarness) {
    const tenant = await relay.createTenant();
    const a = tenant.addNode();
    const joiner = tenant.addNode();
    const clientA = await connected(tenant, a);
    for (let seq = 1; seq < joiner.admit.seq; seq++) await append(clientA, seq);
    const admit = await postKeyLog(relay, tenant, {
      seq: joiner.admit.seq,
      blob: envelope('admit'),
      member: { op: 'admit', bytes: joiner.admit.bytes, sig: joiner.admit.sig },
    });
    expect(admit.status).toBe(200);
    expect(relay.runtime.tenants.getNode(tenant.id, joiner.nodeId)?.status).toBe('admitted');
    return { tenant, joiner };
  }

  test('旧版 CLI 口令加入：根签名 admit 之后只放行紧随的一条令牌追加', async () => {
    const relay = await boot();
    const { tenant, joiner } = await rootAdmitOverHttp(relay);
    const next = joiner.admit.seq + 1;
    const meta = await postKeyLog(relay, tenant, { seq: next, blob: envelope('meta') });
    expect(meta.status).toBe(200);
    expect(relay.runtime.keyLog.getMeta(tenant.id, BigInt(next))?.appendedBy).toBe(joiner.nodeId);
    const extra = await postKeyLog(relay, tenant, { seq: next + 1, blob: envelope('extra') });
    expect(extra.status).toBe(403);
  });

  test('旧版 CLI 口令加入的紧随追加过了时间窗就不再放行', async () => {
    const relay = await boot();
    const { tenant, joiner } = await rootAdmitOverHttp(relay);
    relay.advance(RELAY_JOIN_FOLLOWUP_WINDOW_MS + 1);
    const stale = await postKeyLog(relay, tenant, {
      seq: joiner.admit.seq + 1,
      blob: envelope('stale'),
    });
    expect(stale.status).toBe(403);
  });

  test('中继不改写已有的行：seq 不是 head+1 的根签名 revoke / 根轮换回 SEQ_MISMATCH', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const a = tenant.addNode();
    const b = tenant.addNode();
    const clientA = await connected(tenant, a);
    const clientB = await connected(tenant, b);
    const revoke = tenant.revokeRecord(b.nodeId);
    for (let seq = 1; seq <= revoke.seq + 1; seq++) await append(clientB, seq);
    const rotate = tenant.rotateRootRecord();
    const cases = [
      { op: 'revoke' as const, rec: revoke },
      { op: 'rotate-root' as const, rec: rotate },
    ];
    for (const { op, rec } of cases) {
      const ack = await append(clientA, rec.seq, { op, bytes: rec.bytes, sig: rec.sig });
      expect(ack.ok).toBe(false);
      expect(ack.error).toBe('SEQ_MISMATCH');
    }
    expect(headOf(relay, tenant)).toBe(revoke.seq + 1);
    expect(relay.runtime.tenants.getNode(tenant.id, b.nodeId)?.status).toBe('admitted');
    expect(relay.runtime.keyLog.getMeta(tenant.id, BigInt(revoke.seq))?.appendedBy).toBe(b.nodeId);
  });
});

describe('吊销后吊销前签发的令牌失去凭令牌访问的宽限', () => {
  test('历史令牌立刻对 HTTP 失效；当前令牌保持，下次 enroll 必换发且旧令牌不再有 HTTP 宽限', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const a = tenant.addNode();
    const b = tenant.addNode();
    const clientA = await connected(tenant, a);
    await connected(tenant, b);
    const rotated = await enrollRelayRoot(relay, tenant.root);
    const fresh = rotated.token;
    if (!fresh) throw new Error('expected a rotated token');
    const keyLogPath = `/api/relay/tenants/${tenant.id}/keylog?from_seq=1`;
    expect((await relay.tenantFetch(keyLogPath, tenant.token)).status).toBe(200);

    const reconnectA = await tenant.connect(a, { token: fresh });
    await reconnectA.inbox.takeOf('auth.ok');
    await tenant.appendMember(reconnectA, 'revoke', tenant.revokeRecord(b.nodeId));
    void clientA;
    expect((await relay.tenantFetch(keyLogPath, tenant.token)).status).toBe(401);
    expect((await relay.tenantFetch(keyLogPath, fresh)).status).toBe(200);

    const again = await enrollRelayRoot(relay, tenant.root, { knownTokenHash: sha256Hex(fresh) });
    expect(again.token).not.toBeNull();
    expect(again.token_unchanged).not.toBe(true);
    expect((await relay.tenantFetch(keyLogPath, fresh)).status).toBe(401);
    const survivor = await tenant.connect(a, { token: fresh });
    expect((await survivor.inbox.takeOf('auth.ok')).t).toBe('auth.ok');
  });
});

describe('每租户密钥日志上限', () => {
  test('超过行数上限回 TENANT_LOG_FULL', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    const client = await connected(tenant, node);
    relay.runtime.tenants.setKeyLogHead(tenant.id, 100_000n);
    const ack = await append(client, 100_001);
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('TENANT_LOG_FULL');
  });

  test('超过字节上限回 TENANT_LOG_FULL（HTTP 为 507）', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    await connected(tenant, node);
    const store = relay.runtime.keyLog;
    const big = 'x'.repeat(1024 * 1024);
    for (let seq = 1; seq <= 64; seq++) {
      store.append({
        tenantId: tenant.id,
        seq: BigInt(seq),
        envelope: { v: 1, n: 'AAAAAAAAAAAAAAAA', ct: big },
        appendedBy: node.nodeId,
        rootOp: null,
        now: relay.now(),
      });
    }
    relay.runtime.tenants.setKeyLogHead(tenant.id, 64n);
    const blob = envelope('over');
    const sig = signRelayKeyLogAppend(node.ed.secretKey, {
      relayHost: relay.runtime.uplink.relayHost,
      tenantId: tenant.id,
      seq: 65n,
      envelope: blob,
    });
    const res = await postKeyLog(relay, tenant, {
      seq: 65,
      blob,
      node_id: node.nodeId,
      node_sig: encodeBase64url(sig),
    });
    expect(res.status).toBe(507);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('TENANT_LOG_FULL');
  });
});

describe('redeem 响应只随带有界的日志前缀', () => {
  test('超过字节上限置 has_more，前缀从 seq 1 连续', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const first = tenant.addNode();
    const client = await connected(tenant, first);
    const big = 'x'.repeat(1024 * 1024);
    for (let seq = 1; seq <= 9; seq++) {
      relay.runtime.keyLog.append({
        tenantId: tenant.id,
        seq: BigInt(seq),
        envelope: { v: 1, n: 'AAAAAAAAAAAAAAAA', ct: big },
        appendedBy: first.nodeId,
        rootOp: null,
        now: relay.now(),
      });
    }
    relay.runtime.tenants.setKeyLogHead(tenant.id, 9n);
    const second = tenant.addNode();
    await tenant.createEnrollment(second, client);
    const res = await tenant.redeem(second);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key_log: Array<{ seq: number }>; has_more: boolean };
    expect(body.has_more).toBe(true);
    expect(body.key_log.length).toBeGreaterThan(0);
    expect(body.key_log.length).toBeLessThan(9);
    expect(body.key_log.map((row) => row.seq)).toEqual(
      Array.from({ length: body.key_log.length }, (_, i) => i + 1)
    );
  });
});

describe('redeem 不能给已有 node_id 换公钥', () => {
  test('同 node_id、不同公钥的证书 redeem 回 409 RELAY_MEMBER_CONFLICT，注册表不变', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const first = tenant.addNode();
    const client = await connected(tenant, first);
    const second = tenant.addNode();
    await tenant.createEnrollment(second, client);
    const before = relay.runtime.tenants.getNode(tenant.id, first.nodeId);
    relay.runtime.tenants.upsertNode({
      tenantId: tenant.id,
      nodeId: second.nodeId,
      edPk: randomBytes(32),
      x25519Pk: randomBytes(32),
      status: 'admitted',
      now: relay.now(),
    });
    const res = await tenant.redeem(second);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'RELAY_MEMBER_CONFLICT'
    );
    expect(relay.runtime.tenants.getNode(tenant.id, first.nodeId)).toEqual(before);
  });
});

async function closedReason(client: RelayNodeClient): Promise<string> {
  return (await client.link.closed).reason;
}

function selfSig(
  node: RelayNodeFixture,
  relay: RelayHarness,
  tenantId: string,
  seq: number,
  blob: RelayEnvelope
) {
  return encodeBase64url(
    signRelayKeyLogAppend(node.ed.secretKey, {
      relayHost: relay.runtime.uplink.relayHost,
      tenantId,
      seq: BigInt(seq),
      envelope: blob,
    })
  );
}

async function padTo(
  client: RelayNodeClient,
  relay: RelayHarness,
  tenant: RelayTenantHandle,
  seq: number
) {
  for (let next = headOf(relay, tenant) + 1; next < seq; next++) await append(client, next);
}

describe('uplink 认证不凭 passkey admit 建行或升行', () => {
  test('中继上没有对应行时，passkey admit 的 relay.auth 被拒且不建行', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    await connected(tenant, tenant.addNode());
    const unadmitted = tenant.addNode({ admitSigner: 'passkey' });
    const client = await tenant.connect(unadmitted);
    expect(await closedReason(client)).toBe('member-passkey_unadmitted');
    expect(relay.runtime.tenants.getNode(tenant.id, unadmitted.nodeId)).toBeNull();
  });

  test('passkey admit 只能认领已有 pending 行：认证通过但不升 admitted，经 keylog.append 推进后才准入', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const entry = await connected(tenant, tenant.addNode());
    const joiner = tenant.addNode({ admitSigner: 'passkey' });
    await tenant.createEnrollment(joiner, entry);
    expect((await tenant.redeem(joiner)).status).toBe(200);
    const pending = await connected(tenant, joiner);
    expect(relay.runtime.tenants.getNode(tenant.id, joiner.nodeId)?.status).toBe('pending');
    const refused = await append(pending, headOf(relay, tenant) + 1);
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe('NODE_NOT_ADMITTED');
    const ack = await tenant.appendMember(entry, 'admit', joiner.admit);
    expect(ack.ok).toBe(true);
    expect(ack.member_error).toBeUndefined();
    expect(relay.runtime.tenants.getNode(tenant.id, joiner.nodeId)?.status).toBe('admitted');
  });

  test('根签名 admit 在 relay.auth 上建行前检查节点配额', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    relay.runtime.tenants.patch(tenant.id, {
      quota: { maxNodes: 1, maxStreams: 64, bandwidthBytesPerSec: null, maxFileBytes: null },
    });
    await connected(tenant, tenant.addNode());
    const extra = tenant.addNode();
    expect(await closedReason(await tenant.connect(extra))).toBe('quota-nodes');
    expect(relay.runtime.tenants.getNode(tenant.id, extra.nodeId)).toBeNull();
  });
});

describe('根签名吊销总会收紧令牌；force_rotate 显式换发', () => {
  test('吊销中继从没见过的节点：插 revoked 行，令牌照样收紧，下次 enroll 必换发', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const client = await connected(tenant, tenant.addNode());
    const lanOnly = 'd'.repeat(32);
    const ack = await tenant.appendMember(client, 'revoke', tenant.revokeRecord(lanOnly));
    expect(ack.ok).toBe(true);
    expect(ack.member_error).toBeUndefined();
    expect(relay.runtime.tenants.getNode(tenant.id, lanOnly)?.status).toBe('revoked');
    const row = relay.runtime.tenants.get(tenant.id);
    if (!row) throw new Error('tenant vanished');
    expect(relayCurrentTokenPredatesRevoke(row)).toBe(true);
    const again = await enrollRelayRoot(relay, tenant.root, {
      knownTokenHash: sha256Hex(tenant.token),
    });
    expect(again.token).not.toBeNull();
  });

  test('force_rotate：持当前令牌也换发，旧令牌只剩 uplink 宽限', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    await connected(tenant, node);
    const known = { knownTokenHash: sha256Hex(tenant.token) };
    const reuse = await enrollRelayRoot(relay, tenant.root, known);
    expect(reuse.token_unchanged).toBe(true);
    const rotated = await enrollRelayRoot(relay, tenant.root, { ...known, forceRotate: true });
    expect(rotated.token).not.toBeNull();
    const keyLogPath = `/api/relay/tenants/${tenant.id}/keylog?from_seq=1`;
    expect((await relay.tenantFetch(keyLogPath, tenant.token)).status).toBe(401);
    expect((await relay.tenantFetch(keyLogPath, rotated.token ?? '')).status).toBe(200);
    const survivor = await tenant.connect(node, { token: tenant.token });
    expect((await survivor.inbox.takeOf('auth.ok')).t).toBe('auth.ok');
  });
});

describe('force_rotate 换发随带已吊销节点', () => {
  async function passkeyRevoked(relay: RelayHarness) {
    const tenant = await relay.createTenant();
    const entry = await connected(tenant, tenant.addNode());
    const x = tenant.addNode();
    const clientX = await connected(tenant, x);
    const ack = await tenant.appendMember(
      entry,
      'revoke',
      tenant.revokeRecord(x.nodeId, 'passkey')
    );
    expect(ack.ok).toBe(true);
    expect(ack.member_error).toBe('passkey_unverifiable');
    expect(relay.runtime.tenants.getNode(tenant.id, x.nodeId)?.status).toBe('admitted');
    return { tenant, x, clientX };
  }

  test('根证明的 force_rotate 把列出的节点标为吊销、断开链路，新旧令牌都不能再让它接入', async () => {
    const relay = await boot();
    const { tenant, x, clientX } = await passkeyRevoked(relay);
    const unknown = 'e'.repeat(32);
    const rotated = await enrollRelayRoot(relay, tenant.root, {
      knownTokenHash: sha256Hex(tenant.token),
      forceRotate: true,
      revokedNodeIds: [x.nodeId, unknown],
    });
    expect(rotated.token).not.toBeNull();
    expect(relay.runtime.tenants.getNode(tenant.id, x.nodeId)?.status).toBe('revoked');
    expect(relay.runtime.tenants.getNode(tenant.id, unknown)?.status).toBe('revoked');
    const kicked = await clientX.inbox.takeOf('relay.kicked');
    expect(kicked.t === 'relay.kicked' && kicked.reason).toBe('revoked');
    expect(await closedReason(await tenant.connect(x, { token: tenant.token }))).toBe('revoked');
    expect(await closedReason(await tenant.connect(x, { token: rotated.token ?? '' }))).toBe(
      'revoked'
    );
    const keyLogPath = `/api/relay/tenants/${tenant.id}/keylog?from_seq=1`;
    expect((await relay.tenantFetch(keyLogPath, tenant.token)).status).toBe(401);
  });

  test('不带 force_rotate 时 revoked_node_ids 被忽略', async () => {
    const relay = await boot();
    const { tenant, x } = await passkeyRevoked(relay);
    const again = await enrollRelayRoot(relay, tenant.root, {
      knownTokenHash: sha256Hex(tenant.token),
      revokedNodeIds: [x.nodeId],
    });
    expect(again.token_unchanged).toBe(true);
    expect(relay.runtime.tenants.getNode(tenant.id, x.nodeId)?.status).toBe('admitted');
  });

  test('revoked_node_ids 不是 hex node_id 数组或超过上限回 400', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    for (const bad of [['not-hex'], 'abc', Array.from({ length: 257 }, () => 'f'.repeat(32))]) {
      await expect(
        enrollRelayRoot(relay, tenant.root, {
          forceRotate: true,
          revokedNodeIds: bad as string[],
        })
      ).rejects.toThrow('400');
    }
  });
});

describe('只有 HTTP 自我 admit 才打开旧版 CLI 紧随窗口', () => {
  test('经 uplink 落地的根签名 admit 之后，令牌追加照样 403', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const entry = await connected(tenant, tenant.addNode());
    const joiner = tenant.addNode();
    expect((await tenant.appendMember(entry, 'admit', joiner.admit)).ok).toBe(true);
    const head = headOf(relay, tenant);
    expect(relay.runtime.keyLog.getMeta(tenant.id, BigInt(head))?.via).toBe('uplink');
    const junk = await postKeyLog(relay, tenant, { seq: head + 1, blob: envelope('junk') });
    expect(junk.status).toBe(403);
    expect(headOf(relay, tenant)).toBe(head);
  });

  test('紧随追加不能带成员明文', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const a = tenant.addNode();
    const joiner = tenant.addNode();
    const clientA = await connected(tenant, a);
    await padTo(clientA, relay, tenant, joiner.admit.seq);
    const admit = await postKeyLog(relay, tenant, {
      seq: joiner.admit.seq,
      blob: envelope('admit'),
      member: { op: 'admit', bytes: joiner.admit.bytes, sig: joiner.admit.sig },
    });
    expect(admit.status).toBe(200);
    const unadmitted = tenant.addNode({ admitSigner: 'passkey' });
    const res = await postKeyLog(relay, tenant, {
      seq: joiner.admit.seq + 1,
      blob: envelope('unadmitted'),
      member: { op: 'admit', bytes: unadmitted.admit.bytes, sig: unadmitted.admit.sig },
    });
    expect(res.status).toBe(403);
    expect(relay.runtime.tenants.getNode(tenant.id, unadmitted.nodeId)).toBeNull();
  });
});

describe('HTTP 上根签名 sidecar 只为口令加入的自我 admit 背书', () => {
  test('根签名 revoke 经 HTTP 不带已准入节点签名 → 403，吊销不生效', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const a = tenant.addNode();
    const b = tenant.addNode();
    const clientA = await connected(tenant, a);
    await connected(tenant, b);
    const revoke = tenant.revokeRecord(b.nodeId);
    await padTo(clientA, relay, tenant, revoke.seq);
    const res = await postKeyLog(relay, tenant, {
      seq: revoke.seq,
      blob: envelope('junk'),
      member: { op: 'revoke', bytes: revoke.bytes, sig: revoke.sig },
    });
    expect(res.status).toBe(403);
    expect(relay.runtime.tenants.getNode(tenant.id, b.nodeId)?.status).toBe('admitted');
  });

  test('自我 admit 带被准入节点的 node_sig 被接受；已知节点的 admit 不带签名被拒', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const a = tenant.addNode();
    const signed = tenant.addNode();
    const known = tenant.addNode();
    const clientA = await connected(tenant, a);
    await tenant.createEnrollment(known, clientA);
    expect((await tenant.redeem(known)).status).toBe(200);
    await padTo(clientA, relay, tenant, signed.admit.seq);
    const blob = envelope('self-admit');
    const res = await postKeyLog(relay, tenant, {
      seq: signed.admit.seq,
      blob,
      member: { op: 'admit', bytes: signed.admit.bytes, sig: signed.admit.sig },
      node_id: signed.nodeId,
      node_sig: selfSig(signed, relay, tenant.id, signed.admit.seq, blob),
    });
    expect(res.status).toBe(200);
    const meta = relay.runtime.keyLog.getMeta(tenant.id, BigInt(signed.admit.seq));
    expect(meta?.appendedBy).toBe(signed.nodeId);
    expect(meta?.via).toBe('http');
    expect(meta?.admittedNodeId).toBe(signed.nodeId);
    const unsigned = await postKeyLog(relay, tenant, {
      seq: known.admit.seq,
      blob: envelope('known'),
      member: { op: 'admit', bytes: known.admit.bytes, sig: known.admit.sig },
    });
    expect(unsigned.status).toBe(403);
    expect(relay.runtime.tenants.getNode(tenant.id, known.nodeId)?.status).toBe('pending');
  });
});

describe('被拒的追加不清字节缓存', () => {
  test('只凭令牌的垃圾追加 403，且不触发 forgetBytes', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    await connected(tenant, tenant.addNode());
    const forget = spyOn(relay.runtime.keyLog, 'forgetBytes');
    const res = await postKeyLog(relay, tenant, { seq: 1, blob: envelope('junk') });
    expect(res.status).toBe(403);
    expect(forget).not.toHaveBeenCalled();
    forget.mockRestore();
  });
});
