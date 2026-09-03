import {
  DOMAIN_AUTHORIZATION,
  type RootKey,
  buildKeyLogRecord,
  computeRecordHash,
  createNodeCertificate,
  encodeAdmitNodePayload,
  encodeAuthorization,
  encodeBase64url,
  encodeKeyLogRecord,
  encodeRevokeNodePayload,
  encodeRotateRootKeepPayload,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  nodeIdToHex,
  randomBytes,
  rootKeyFromSeed,
  signEd25519,
  signKeyLogRecordWithRoot,
  uplinkAuthMessage,
} from '@tmex/shared/auth';
import { type LinkSession, type LinkStream, createInMemoryLinkPair } from '@tmex/shared/link';
import {
  MIN_RELAY_CLIENT_VERSION,
  RELAY_PROTO_VERSION,
  type RelayCtlMessage,
  type RelayEnvelope,
  type RelayKeylogMemberOp,
  decodeRelayCtl,
  encodeRelayCtl,
  encodeRelayOpenStream,
  signRelayEnrollProof,
} from '@tmex/shared/relay';
import { encodePasskeyAssertionSig } from '../auth/passkey';
import { createEs256Authenticator } from '../auth/passkey-test-fixtures';
import { encodeRedeemPopMessage } from '../hub/redeem-pop';
import {
  RELAY_TEST_PUBLIC_URL,
  type RelayCtlInbox,
  type RelayHarness,
  relayCtlInbox,
  testEnvelope,
} from './relay-test-harness';

/** 明文成员记录：`seq` 是记录自身在密钥日志里的序号（中继要求它等于 append 的 seq）。 */
export type RelayMemberFixture = { bytes: string; sig: string; seq: number };
export type RelayRotateFixture = RelayMemberFixture & { apply(): void };

export type RelayNodeFixture = {
  nodeId: string;
  ed: { secretKey: Uint8Array; publicKey: Uint8Array };
  x25519: { secretKey: Uint8Array; publicKey: Uint8Array };
  enroll: { secretKey: Uint8Array; publicKey: Uint8Array };
  certBytes: Uint8Array;
  certSig: Uint8Array;
  authorizationBytes: Uint8Array;
  authorizationSig: Uint8Array;
  admit: RelayMemberFixture;
};

export type RelayNodeClient = {
  nodeId: string;
  link: LinkSession;
  inbox: RelayCtlInbox;
  send(msg: RelayCtlMessage): void;
  openRelay(to: string): Promise<LinkStream>;
  onStream(cb: (stream: LinkStream) => void): void;
  close(): void;
};

export type RelayTenantHandle = {
  id: string;
  token: string;
  root: RootKey;
  uid: string;
  passwordEpoch: number;
  rootEpoch(): number;
  addNode(opts?: { admitSigner?: 'root' | 'passkey' }): RelayNodeFixture;
  revokeRecord(nodeId: string, signer?: 'root' | 'passkey'): RelayMemberFixture;
  /** 用当前根签一条 `rotate-root-keep`；调 `apply()` 后 handle 才切到新根（便于造旧根签的记录）。 */
  rotateRootRecord(): RelayRotateFixture;
  /** 追加到 `record.seq` 为止：前面的空位用无 member 的占位记录补齐，最后一条带上 member。 */
  appendMember(
    client: RelayNodeClient,
    op: RelayKeylogMemberOp,
    record: RelayMemberFixture
  ): Promise<Extract<RelayCtlMessage, { t: 'relay.keylog.ack' }>>;
  redeem(node: RelayNodeFixture): Promise<Response>;
  lookupEnrollment(node: RelayNodeFixture, token?: string): Promise<Response>;
  createEnrollment(node: RelayNodeFixture, client: RelayNodeClient, id?: string): Promise<void>;
  connect(
    node: RelayNodeFixture,
    opts?: { withMember?: boolean; clientVersion?: string; token?: string }
  ): Promise<RelayNodeClient>;
};

export async function enrollRelayRoot(
  harness: RelayHarness,
  root: RootKey,
  opts?: { password?: string; rootEpoch?: number }
): Promise<{ tenant_id: string; token: string; password_epoch: number }> {
  const proof = signRelayEnrollProof(root, {
    relayHost: new URL(RELAY_TEST_PUBLIC_URL).host,
    ts: harness.now(),
  });
  const res = await harness.fetch('/api/relay/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(opts?.password === undefined ? {} : { password: opts.password }),
      root_public_key: encodeBase64url(root.publicKey),
      root_epoch: opts?.rootEpoch ?? 0,
      proof: { bytes: encodeBase64url(proof.bytes), sig: encodeBase64url(proof.sig) },
    }),
  });
  if (!res.ok) throw new Error(`relay enroll failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { tenant_id: string; token: string; password_epoch: number };
}

export async function createTenant(
  harness: RelayHarness,
  now: () => number,
  opts?: { password?: string; uid?: string }
): Promise<RelayTenantHandle> {
  const root = rootKeyFromSeed(randomBytes(32));
  const uid = opts?.uid ?? `uid-${encodeBase64url(randomBytes(6))}`;
  const proof = signRelayEnrollProof(root, {
    relayHost: new URL(RELAY_TEST_PUBLIC_URL).host,
    ts: now(),
  });
  const res = await harness.fetch('/api/relay/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(opts?.password === undefined ? {} : { password: opts.password }),
      root_public_key: encodeBase64url(root.publicKey),
      root_epoch: 0,
      proof: { bytes: encodeBase64url(proof.bytes), sig: encodeBase64url(proof.sig) },
    }),
  });
  if (!res.ok) throw new Error(`relay enroll failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    tenant_id: string;
    token: string;
    password_epoch: number;
  };
  return makeTenantHandle(harness, now, {
    id: body.tenant_id,
    token: body.token,
    passwordEpoch: body.password_epoch,
    root,
    uid,
    passkeySig: await realPasskeyAssertion(uid),
  });
}

/**
 * 真实的 ES256 断言（变长 Borsh `PasskeyAssertion`，约 300 B），不是 64 个零字节。
 * 中继按设计验不了 passkey 签名（验签需要 clientDataJSON 的 origin），所以这里不做逐记录挑战绑定；
 * 要测的是「变长签名能过编解码、且中继对它一律不采信」。
 */
async function realPasskeyAssertion(uid: string): Promise<Uint8Array> {
  const authenticator = await createEs256Authenticator();
  const assertion = await authenticator.assert({
    challenge: new TextEncoder().encode(`relay-test/${uid}`),
    rpId: 'relay.example',
    origin: 'https://relay.example',
    counter: 1,
  });
  return encodePasskeyAssertionSig(assertion);
}

/** 造一台节点：链路/加密/enroll 三对密钥 + 证书 + 根签的 authorization + 一条 admit-node。 */
function makeNodeFixture(ctx: {
  uid: string;
  root: RootKey;
  rootEpoch: number;
  now: number;
  sign: (payload: Uint8Array, signer: 'root' | 'passkey') => RelayMemberFixture;
  admitSigner: 'root' | 'passkey';
}): RelayNodeFixture {
  const ed = generateEd25519KeyPair();
  const x25519 = generateX25519KeyPair();
  const enroll = generateEd25519KeyPair();
  const cert = createNodeCertificate(enroll.secretKey, {
    uid: ctx.uid,
    edPk: ed.publicKey,
    x25519Pk: x25519.publicKey,
    enrollPk: enroll.publicKey,
    now: ctx.now,
  });
  const authorizationBytes = encodeAuthorization({
    domain: DOMAIN_AUTHORIZATION,
    uid: ctx.uid,
    enroll_pk: enroll.publicKey,
    exp: BigInt(ctx.now + 600_000),
    root_epoch: ctx.rootEpoch,
    signer: 'root',
    credential_id: null,
  });
  const authorizationSig = ctx.root.sign(authorizationBytes);
  const admit = ctx.sign(
    encodeAdmitNodePayload({
      authorization_bytes: authorizationBytes,
      authorization_sig: authorizationSig,
      certificate_bytes: cert.certificateBytes,
      cert_sig: cert.certSig,
    }),
    ctx.admitSigner
  );
  return {
    nodeId: nodeIdToHex(cert.nodeId),
    ed,
    x25519,
    enroll,
    certBytes: cert.certificateBytes,
    certSig: cert.certSig,
    authorizationBytes,
    authorizationSig,
    admit,
  };
}

/** 补齐前置 seq 的占位记录，再把带 member 的那条追加上去（中继要求 member.seq === msg.seq）。 */
async function appendMemberRecord(
  harness: RelayHarness,
  tenantId: string,
  client: RelayNodeClient,
  op: RelayKeylogMemberOp,
  record: RelayMemberFixture
): Promise<Extract<RelayCtlMessage, { t: 'relay.keylog.ack' }>> {
  let current = Number(harness.runtime.tenants.get(tenantId)?.keyLogHeadSeq ?? 0n);
  while (current + 1 < record.seq) {
    current += 1;
    client.send({
      t: 'relay.keylog.append',
      id: `pad-${current}`,
      seq: current,
      blob: testEnvelope(`pad-${current}`),
    });
    await client.inbox.takeOf('relay.keylog.ack');
  }
  client.send({
    t: 'relay.keylog.append',
    id: `member-${record.seq}`,
    seq: record.seq,
    blob: testEnvelope(`member-${record.seq}`),
    member: { op, bytes: record.bytes, sig: record.sig },
  });
  const ack = await client.inbox.takeOf('relay.keylog.ack');
  if (ack.t !== 'relay.keylog.ack') throw new Error('expected relay.keylog.ack');
  return ack;
}

function makeTenantHandle(
  harness: RelayHarness,
  now: () => number,
  base: {
    id: string;
    token: string;
    passwordEpoch: number;
    root: RootKey;
    uid: string;
    passkeySig: Uint8Array;
  }
): RelayTenantHandle {
  let head: { seq: bigint; hash: Uint8Array } = { seq: 0n, hash: new Uint8Array(32) };
  let root = base.root;
  let rootEpoch = 0;
  const signRecord = (
    type: 'admit-node' | 'revoke-node' | 'rotate-root-keep',
    payload: Uint8Array,
    signer: 'root' | 'passkey'
  ): RelayMemberFixture => {
    const record = buildKeyLogRecord(head, rootEpoch, {
      uid: base.uid,
      type,
      payload,
      signer,
      credential_id: signer === 'passkey' ? 'test-credential' : null,
    });
    const bytes = encodeKeyLogRecord(record);
    const sig = signer === 'root' ? signKeyLogRecordWithRoot(root, bytes) : base.passkeySig;
    head = { seq: record.seq, hash: computeRecordHash(bytes, sig) };
    return {
      bytes: encodeBase64url(bytes),
      sig: encodeBase64url(sig),
      seq: Number(record.seq),
    };
  };
  return {
    id: base.id,
    token: base.token,
    get root() {
      return root;
    },
    uid: base.uid,
    passwordEpoch: base.passwordEpoch,
    rootEpoch: () => rootEpoch,
    addNode(opts) {
      return makeNodeFixture({
        uid: base.uid,
        root,
        rootEpoch,
        now: now(),
        sign: (payload, signer) => signRecord('admit-node', payload, signer),
        admitSigner: opts?.admitSigner ?? 'root',
      });
    },
    revokeRecord(nodeId, signer = 'root') {
      const raw = new Uint8Array(16);
      for (let i = 0; i < 16; i++) raw[i] = Number.parseInt(nodeId.slice(i * 2, i * 2 + 2), 16);
      return signRecord(
        'revoke-node',
        encodeRevokeNodePayload({ node_id: raw, reason: '' }),
        signer
      );
    },
    rotateRootRecord() {
      const next = rootKeyFromSeed(randomBytes(32));
      const record = signRecord(
        'rotate-root-keep',
        encodeRotateRootKeepPayload({
          root_public_key: next.publicKey,
          kdf_params: { salt: randomBytes(16), memory_kib: 8, iterations: 1, parallelism: 1 },
          totp: null,
        }),
        'root'
      );
      return {
        ...record,
        apply() {
          root = next;
          rootEpoch += 1;
        },
      };
    },
    appendMember: (client, op, record) => appendMemberRecord(harness, base.id, client, op, record),
    redeem(node) {
      return redeemNode(harness, base.id, base.token, node);
    },
    lookupEnrollment(node, token) {
      return harness.tenantFetch(
        `/api/relay/tenants/${base.id}/enrollments/${encodeURIComponent(
          encodeBase64url(node.enroll.publicKey)
        )}`,
        token ?? base.token
      );
    },
    async createEnrollment(node, client, id = `enr-${encodeBase64url(randomBytes(6))}`) {
      client.send({
        t: 'relay.enroll.create',
        id,
        enroll_pk: encodeBase64url(node.enroll.publicKey),
        authorization: encodeBase64url(node.authorizationBytes),
        authorization_sig: encodeBase64url(node.authorizationSig),
        exp: now() + 600_000,
      });
      const ack = await client.inbox.takeOf('relay.enroll.ack');
      if (ack.t !== 'relay.enroll.ack' || !ack.ok) {
        throw new Error(`relay.enroll.create rejected: ${JSON.stringify(ack)}`);
      }
    },
    connect(node, opts) {
      return connectNode(harness, base, node, opts);
    },
  };
}

function redeemNode(
  harness: RelayHarness,
  tenantId: string,
  token: string,
  node: RelayNodeFixture
): Promise<Response> {
  const pop = signEd25519(
    node.ed.secretKey,
    encodeRedeemPopMessage({
      enrollmentId: encodeBase64url(node.enroll.publicKey),
      nodeId: hexToBytes(node.nodeId),
      certBytes: node.certBytes,
    })
  );
  return harness.tenantFetch(`/api/relay/tenants/${tenantId}/enrollments/redeem`, token, {
    method: 'POST',
    body: JSON.stringify({
      certificate: encodeBase64url(node.certBytes),
      cert_sig: encodeBase64url(node.certSig),
      pop: encodeBase64url(pop),
    }),
  });
}

async function connectNode(
  harness: RelayHarness,
  tenant: { id: string; token: string },
  node: RelayNodeFixture,
  opts?: { withMember?: boolean; clientVersion?: string; token?: string }
): Promise<RelayNodeClient> {
  const [nodeLink, relayLink] = createInMemoryLinkPair();
  const inbox = relayCtlInbox(nodeLink);
  const streamCbs: Array<(stream: LinkStream) => void> = [];
  nodeLink.onStream((stream) => {
    for (const cb of streamCbs) cb(stream);
  });
  harness.runtime.uplink.accept(relayLink);
  const challenge = await inbox.takeOf('auth.challenge');
  if (challenge.t !== 'auth.challenge') throw new Error('expected auth.challenge');
  const nonce = decodeNonce(challenge.nonce);
  const sig = signEd25519(
    node.ed.secretKey,
    uplinkAuthMessage(nonce, new URL(RELAY_TEST_PUBLIC_URL).host)
  );
  const client: RelayNodeClient = {
    nodeId: node.nodeId,
    link: nodeLink,
    inbox,
    send(msg) {
      nodeLink.ctl.send(encodeRelayCtl(msg));
    },
    openRelay(to) {
      return nodeLink.openStream(encodeRelayOpenStream({ to }));
    },
    onStream(cb) {
      streamCbs.push(cb);
    },
    close() {
      nodeLink.close('test');
    },
  };
  client.send({
    t: 'relay.auth',
    tenant_id: tenant.id,
    token: opts?.token ?? tenant.token,
    node_id: node.nodeId,
    sig: encodeBase64url(sig),
    proto: RELAY_PROTO_VERSION,
    client_version: opts?.clientVersion ?? MIN_RELAY_CLIENT_VERSION,
    ...(opts?.withMember === false ? {} : { member: node.admit }),
  });
  return client;
}

function decodeNonce(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'base64url'));
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
