import {
  type RootKey,
  buildKeyLogRecord,
  createEnrollment,
  createNodeCertificate,
  decodeAuthorization,
  decodeBase64url,
  decodeKeyLogRecord,
  encodeAdmitNodePayload,
  encodeBase64url,
  encodeKeyLogRecord,
  encodeRevokeNodePayload,
  encodeRotateRootKeepPayload,
  hexToBytes,
  randomBytes,
  rootKeyFromSeed,
  signEd25519,
  signKeyLogRecordWithRoot,
  verifyKeyLogChain,
} from '@tmex/shared/auth';
import { openRelayKeyLogRecord, signRelayEnrollProof } from '@tmex/shared/relay';
import {
  KeyLogStore,
  NodeIdentityStore,
  NodeSessionStore,
  UserKeyService,
  UserStore,
  ensureNodeIdentity,
} from '../../auth';
import { MeshRelayStore, RELAY_LOG_KEY_EPOCH } from '../../auth/mesh-relay-store';
import { createMigratedAuthDb } from '../../auth/test-db';
import { encodeRedeemPopMessage } from '../../hub/redeem-pop';
import { waitUntil } from '../../mesh/integration/multi-hub-harness';
import {
  RELAY_TEST_PUBLIC_URL,
  type RelayKeyLogPage,
  type RelayMeshHarness,
  type RelayMeshNode,
  type RelayTenant,
  waitUntilAsync,
} from './relay-mesh-types';

export async function callRelayEnroll(
  tenant: RelayTenant,
  opts: { password?: string }
): Promise<Response> {
  const material = await tenant.owner.json<{ relayHost: string; ts: number }>(
    '/api/mesh/relay/enroll/proof-material',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: RELAY_TEST_PUBLIC_URL }),
    }
  );
  const proof = signRelayEnrollProof(tenant.rootKey, {
    relayHost: material.relayHost,
    ts: material.ts,
  });
  return tenant.owner.call('/api/mesh/relay/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: RELAY_TEST_PUBLIC_URL,
      ...(opts.password === undefined ? {} : { password: opts.password }),
      proof: { bytes: encodeBase64url(proof.bytes), sig: encodeBase64url(proof.sig) },
    }),
  });
}

/** 待签 payload → 根钥签名 → `POST /api/auth/keylog`（与 CLI / 前端同一条路径）。 */
export async function submitPrepared(
  tenant: RelayTenant,
  res: Response,
  type: 'set-relays' | 'meta-key'
): Promise<void> {
  const body = (await res.json()) as { payload: string };
  const submitted = await submitRecord(tenant, tenant.owner, type, decodeBase64url(body.payload));
  if (submitted.status !== 200) {
    throw new Error(`${type} submit ${submitted.status}: ${await submitted.text()}`);
  }
}

/**
 * 根轮换（`rotate-root-keep`，旧根签名）。节点侧上传时会带 `member.op = 'rotate-root'` 明文，
 * 中继据此把租户根公钥/epoch 换掉——否则轮换之后中继会一直用旧公钥验成员记录。
 */
export async function rotateTenantRoot(
  harness: RelayMeshHarness,
  tenant: RelayTenant
): Promise<RootKey> {
  const next = rootKeyFromSeed(randomBytes(32));
  const applied = await submitRecord(
    tenant,
    tenant.owner,
    'rotate-root-keep',
    encodeRotateRootKeepPayload({
      root_public_key: next.publicKey,
      kdf_params: { salt: randomBytes(16), memory_kib: 19_456, iterations: 2, parallelism: 1 },
      totp: null,
    })
  );
  if (applied.status !== 200) {
    throw new Error(`rotate-root-keep ${applied.status}: ${await applied.text()}`);
  }
  tenant.rootKey = next;
  tenant.rootPublicKey = next.publicKey;
  tenant.rootEpoch += 1;
  const tenantId = tenant.tenantId();
  await waitUntil(
    () => harness.relay.runtime.tenants.get(tenantId)?.rootEpoch === tenant.rootEpoch,
    8_000
  );
  return next;
}

export async function submitRecord(
  tenant: RelayTenant,
  node: RelayMeshNode,
  type: 'set-relays' | 'meta-key' | 'admit-node' | 'revoke-node' | 'rotate-root-keep',
  payload: Uint8Array
): Promise<Response> {
  const head = await node.json<{ seq: number | string; hash: string; rootEpoch: number }>(
    '/api/auth/keylog/head'
  );
  const record = buildKeyLogRecord(
    { seq: BigInt(head.seq), hash: decodeBase64url(head.hash) },
    head.rootEpoch,
    { uid: tenant.userId, type, payload, signer: 'root', credential_id: null }
  );
  const bytes = encodeKeyLogRecord(record);
  const sig = signKeyLogRecordWithRoot(tenant.rootKey, bytes);
  const query = node.mesh.uplink.state === 'online' ? '?hub=sync' : '';
  return node.call(`/api/auth/keylog${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bytes: encodeBase64url(bytes), sig: encodeBase64url(sig) }),
  });
}

type JoinMaterialWire = {
  logKey?: string;
  relays?: Array<{ url: string; tenantId: string; token: string }>;
};

export function primaryJoinRelay(material: JoinMaterialWire): {
  tenantId: string;
  token: string;
  logKey: string;
} {
  const primary = material.relays?.[0];
  if (!primary?.tenantId || !primary.token) {
    throw new Error('join-material missing relays[0]');
  }
  return {
    tenantId: primary.tenantId,
    token: primary.token,
    logKey: material.logKey ?? '',
  };
}

/** 复刻 `packages/app/src/commands/relay-join.ts` 的 r3 加入路径（同一批 shared 助手）。 */
export async function joinNode(
  harness: RelayMeshHarness,
  tenant: RelayTenant,
  label: string
): Promise<RelayMeshNode> {
  const wire = await tenant.owner.json<JoinMaterialWire>('/api/mesh/relay/join-material');
  const material = primaryJoinRelay(wire);
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
  if (created.status !== 201) {
    throw new Error(`relay enrollments ${created.status}: ${await created.text()}`);
  }
  const enrollmentId = ((await created.json()) as { id: string }).id;
  await waitRelayKeyLogSynced(harness, tenant);
  const { db, close } = createMigratedAuthDb();
  const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
  const uid = await lookupEnrollmentUid(harness, material, enrollment.enrollPk);
  if (uid !== tenant.userId) throw new Error(`enrollment uid mismatch: ${uid}`);
  const cert = createNodeCertificate(enrollment.enrollSk, {
    uid,
    edPk: identity.edPublicKey,
    x25519Pk: identity.x25519PublicKey,
    enrollPk: enrollment.enrollPk,
    now,
    nodeId: identity.nodeId,
  });
  const redeemed = await redeemAtRelay(harness, material, {
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
  const logKey = decodeBase64url(material.logKey);
  const records = await openRelayKeyLogPage(logKey, redeemed.key_log);
  const head = await tenant.owner.keys.head(tenant.userId);
  const verified = await verifyKeyLogChain(records, tenant.rootPublicKey, head.hash);
  if (!verified.ok) throw new Error(`join chain rejected: ${verified.error}`);
  if (decodeKeyLogRecord(records[0]?.bytes ?? new Uint8Array()).uid !== tenant.userId) {
    throw new Error('genesis uid mismatch');
  }
  const joinKeys = new UserKeyService({
    db,
    userStore: new UserStore(db),
    keyLogStore: new KeyLogStore(db),
    nodeSessionStore: new NodeSessionStore(db),
  });
  const committed = await joinKeys.commitJoin({
    records,
    expectedRootPublicKey: tenant.rootPublicKey,
    anchorHash: head.hash,
    username: tenant.userId,
    expectedUserId: tenant.userId,
    identity: {
      nodeId: identity.nodeIdHex,
      hubUrl: null,
      edPrivateKey: identity.edPrivateKey,
      x25519PrivateKey: identity.x25519PrivateKey,
      certificateJson: JSON.stringify({
        x25519PublicKey: encodeBase64url(identity.x25519PublicKey),
        certificate: encodeBase64url(cert.certificateBytes),
      }),
      certSig: cert.certSig,
      userId: tenant.userId,
    },
  });
  if (!committed.ok) throw new Error(`commitJoin failed: ${committed.error}`);
  const store = new MeshRelayStore(db);
  await store.replaceRelays(
    redeemed.relays.map((url, index) => ({
      url,
      tenantId: material.tenantId,
      token: decodeBase64url(material.token),
      priority: index,
    })),
    now
  );
  await store.putSecret('log', RELAY_LOG_KEY_EPOCH, logKey, now);
  store.setUplinkKind('relay');
  await admitRedeemed(tenant, enrollmentId, identity.nodeIdHex);
  const node = await harness.bootNode(label, {
    userId: tenant.userId,
    rootKey: tenant.rootKey,
    db,
    close,
  });
  tenant.nodes.push(node);
  await waitUntil(() => node.mesh.uplink.state === 'online', 8_000);
  // 承认与 `meta-key` 记录都在 redeem 之后才落账，加入方要靠 uplink 补齐后才有 K_meta
  await waitUntil(() => node.metaEpochs().length > 0, 8_000);
  return node;
}

/** 中继侧密钥日志追平本地 head：加入方 redeem 拿到的整链必须能对上主节点的 head hash。 */
export async function waitRelayKeyLogSynced(
  harness: RelayMeshHarness,
  tenant: RelayTenant,
  timeoutMs = 8_000
): Promise<void> {
  const tenantId = tenant.tenantId();
  await waitUntilAsync(async () => {
    const local = await tenant.owner.keys.head(tenant.userId);
    const remote = harness.relay.runtime.tenants.get(tenantId)?.keyLogHeadSeq ?? 0n;
    if (remote >= local.seq) return true;
    tenant.owner.relayClient()?.requestCatchUpNow();
    return false;
  }, timeoutMs);
}

/** 中继 redeem 后由租户主节点承认：admit-node + `meta-key`(admit)，与前端加节点向导一致。 */
async function admitRedeemed(
  tenant: RelayTenant,
  enrollmentId: string,
  nodeId: string
): Promise<void> {
  await waitUntilAsync(async () => {
    const row = await tenant.owner.json<{ status: string }>(
      `/api/mesh/relay/enrollments/${enrollmentId}`
    );
    return row.status === 'redeemed';
  }, 8_000);
  const row = await tenant.owner.json<{ certificate: string; cert_sig: string }>(
    `/api/mesh/relay/enrollments/${enrollmentId}`
  );
  const token = tenant.owner.userStore.getEnrollmentTokenById(enrollmentId);
  if (!token) throw new Error('enrollment token vanished');
  const stored = JSON.parse(token.authorizationJson) as { authorization_b64: string };
  const applied = await submitRecord(
    tenant,
    tenant.owner,
    'admit-node',
    encodeAdmitNodePayload({
      authorization_bytes: decodeBase64url(stored.authorization_b64),
      authorization_sig: token.authorizationSig,
      certificate_bytes: decodeBase64url(row.certificate),
      cert_sig: decodeBase64url(row.cert_sig),
    })
  );
  if (applied.status !== 200) {
    throw new Error(`admit-node ${applied.status}: ${await applied.text()}`);
  }
  await waitUntil(() => tenant.owner.userStore.getCert(nodeId) !== null, 4_000);
  const prepared = await tenant.owner.call('/api/mesh/relay/meta-key/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'admit', node_id: nodeId }),
  });
  if (prepared.status !== 200) {
    throw new Error(`meta-key admit ${prepared.status}: ${await prepared.text()}`);
  }
  const epoch = ((await prepared.clone().json()) as { epoch: number }).epoch;
  await submitPrepared(tenant, prepared, 'meta-key');
  await waitUntil(() => tenant.owner.metaEpochs().includes(epoch), 8_000);
}

async function lookupEnrollmentUid(
  harness: RelayMeshHarness,
  material: { tenantId: string; token: string },
  enrollPk: Uint8Array
): Promise<string> {
  const res = await harness.relay.tenantFetch(
    `/api/relay/tenants/${material.tenantId}/enrollments/${encodeURIComponent(
      encodeBase64url(enrollPk)
    )}`,
    material.token
  );
  if (res.status !== 200) throw new Error(`enrollment lookup ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { authorization: string };
  return decodeAuthorization(decodeBase64url(body.authorization)).uid;
}

export async function redeemAtRelay(
  harness: RelayMeshHarness,
  material: { tenantId: string; token: string },
  input: { certificate: Uint8Array; certSig: Uint8Array; pop: Uint8Array }
): Promise<{ relays: string[]; key_log: RelayKeyLogPage }> {
  const res = await harness.relay.tenantFetch(
    `/api/relay/tenants/${material.tenantId}/enrollments/redeem`,
    material.token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        certificate: encodeBase64url(input.certificate),
        cert_sig: encodeBase64url(input.certSig),
        pop: encodeBase64url(input.pop),
      }),
    }
  );
  if (res.status !== 200) throw new Error(`relay redeem ${res.status}: ${await res.text()}`);
  return (await res.json()) as { relays: string[]; key_log: RelayKeyLogPage };
}

/** join 串下载到的密钥日志页：seq 必须从 1 起连续，逐条用 K_log 解开。 */
export async function openRelayKeyLogPage(
  logKey: Uint8Array,
  items: RelayKeyLogPage
): Promise<Array<{ bytes: Uint8Array; sig: Uint8Array }>> {
  const sorted = [...items].sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
  const out: Array<{ bytes: Uint8Array; sig: Uint8Array }> = [];
  let expected = 1n;
  for (const item of sorted) {
    if (BigInt(item.seq) !== expected) throw new Error(`key log gap at ${item.seq}`);
    expected += 1n;
    out.push(await openRelayKeyLogRecord(logKey, item.blob));
  }
  return out;
}

export async function admitNode(tenant: RelayTenant, node: RelayMeshNode): Promise<void> {
  const cert = tenant.owner.userStore.getCert(node.nodeId);
  if (!cert) throw new Error(`no certificate for ${node.nodeId}`);
  const applied = await submitRecord(
    tenant,
    tenant.owner,
    'admit-node',
    encodeAdmitNodePayload({
      authorization_bytes: cert.authorizationBytes,
      authorization_sig: cert.authorizationSig,
      certificate_bytes: cert.certificateBytes,
      cert_sig: cert.certSig,
    })
  );
  if (applied.status !== 200) {
    throw new Error(`admit-node ${applied.status}: ${await applied.text()}`);
  }
}

export async function revokeNode(tenant: RelayTenant, node: RelayMeshNode): Promise<void> {
  const applied = await submitRecord(
    tenant,
    tenant.owner,
    'revoke-node',
    encodeRevokeNodePayload({ node_id: hexToBytes(node.nodeId), reason: '' })
  );
  if (applied.status !== 200) {
    throw new Error(`revoke-node ${applied.status}: ${await applied.text()}`);
  }
  await rotateMetaKey(tenant, [node.nodeId]);
}

export async function rotateMetaKey(tenant: RelayTenant, exclude: string[] = []): Promise<void> {
  const prepared = await tenant.owner.call('/api/mesh/relay/meta-key/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'rotate', exclude }),
  });
  if (prepared.status !== 200) {
    throw new Error(`meta-key rotate ${prepared.status}: ${await prepared.text()}`);
  }
  const epoch = ((await prepared.clone().json()) as { epoch: number }).epoch;
  await submitPrepared(tenant, prepared, 'meta-key');
  await waitUntil(() => tenant.owner.metaEpochs().includes(epoch), 8_000);
}
