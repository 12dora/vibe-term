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
  decodeRelayCtl,
  encodeRelayCtl,
  encodeRelayOpenStream,
  signRelayEnrollProof,
} from '@tmex/shared/relay';
import { createMigratedAuthDb } from '../auth/test-db';
import type { AuthDb } from '../auth/types';
import { encodeRedeemPopMessage } from '../hub/redeem-pop';
import { RELAY_TOKEN_HEADER } from './relay-routes';
import { type RelayRuntime, createRelayRuntime } from './relay-runtime';
import type { RelayRuntimeConfig } from './types';

export const RELAY_TEST_PUBLIC_URL = 'https://relay.example';
export const RELAY_TEST_ADMIN_TOKEN = 'relay-test-admin-token';

export type RelayCtlInbox = {
  take(timeoutMs?: number): Promise<RelayCtlMessage>;
  takeOf(type: RelayCtlMessage['t'], timeoutMs?: number): Promise<RelayCtlMessage>;
  drain(): RelayCtlMessage[];
};

export type RelayHarnessOptions = {
  config?: Partial<RelayRuntimeConfig>;
  now?: () => number;
  listDebounceMs?: number;
  heartbeatIntervalMs?: number;
  authTimeoutMs?: number;
  meterFlushIntervalMs?: number;
  minClientVersion?: string;
  isLocalUserAuthenticated?: (req: Request) => boolean | Promise<boolean>;
  clientIp?: (req: Request) => string;
  password?: string;
};

export type RelayNodeFixture = {
  nodeId: string;
  ed: { secretKey: Uint8Array; publicKey: Uint8Array };
  x25519: { secretKey: Uint8Array; publicKey: Uint8Array };
  enroll: { secretKey: Uint8Array; publicKey: Uint8Array };
  certBytes: Uint8Array;
  certSig: Uint8Array;
  authorizationBytes: Uint8Array;
  authorizationSig: Uint8Array;
  admit: { bytes: string; sig: string };
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
  addNode(opts?: { admitSigner?: 'root' | 'passkey' }): RelayNodeFixture;
  revokeRecord(nodeId: string, signer?: 'root' | 'passkey'): { bytes: string; sig: string };
  redeem(node: RelayNodeFixture): Promise<Response>;
  lookupEnrollment(node: RelayNodeFixture, token?: string): Promise<Response>;
  createEnrollment(node: RelayNodeFixture, client: RelayNodeClient, id?: string): Promise<void>;
  connect(
    node: RelayNodeFixture,
    opts?: { withMember?: boolean; clientVersion?: string; token?: string }
  ): Promise<RelayNodeClient>;
};

export type RelayHarness = {
  runtime: RelayRuntime;
  db: AuthDb;
  adminToken: string;
  now(): number;
  advance(ms: number): void;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  adminFetch(path: string, init?: RequestInit): Promise<Response>;
  tenantFetch(path: string, token: string, init?: RequestInit): Promise<Response>;
  createTenant(opts?: { password?: string; uid?: string }): Promise<RelayTenantHandle>;
  close(): Promise<void>;
};

const BASE = 'http://relay.local';

function upgradeServer(): { upgrade: () => boolean } {
  return { upgrade: () => false };
}

export function relayCtlInbox(link: LinkSession): RelayCtlInbox {
  const queue: RelayCtlMessage[] = [];
  const waiters: Array<(msg: RelayCtlMessage) => void> = [];
  link.ctl.onMessage((bytes) => {
    let msg: RelayCtlMessage;
    try {
      msg = decodeRelayCtl(bytes);
    } catch {
      return;
    }
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });
  const take = (timeoutMs = 1_000): Promise<RelayCtlMessage> => {
    const queued = queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<RelayCtlMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('relay ctl timeout')), timeoutMs);
      waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  };
  return {
    take,
    async takeOf(type, timeoutMs = 1_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const msg = await take(Math.max(1, deadline - Date.now()));
        if (msg.t === type) return msg;
        if (Date.now() >= deadline) throw new Error(`relay ctl timeout waiting for ${type}`);
      }
    },
    drain() {
      const out = queue.slice();
      queue.length = 0;
      return out;
    },
  };
}

export async function bootRelayHarness(opts: RelayHarnessOptions = {}): Promise<RelayHarness> {
  const { db, close } = createMigratedAuthDb();
  let clock = 1_700_000_000_000;
  const now = opts.now ?? (() => clock);
  const runtime = await createRelayRuntime({
    db,
    now,
    startedAt: now(),
    version: '1.1.23',
    config: {
      publicUrl: RELAY_TEST_PUBLIC_URL,
      stun: ['stun:stun.example:3478'],
      turn: null,
      adminToken: RELAY_TEST_ADMIN_TOKEN,
      ...opts.config,
    },
    listDebounceMs: opts.listDebounceMs ?? 0,
    heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 0,
    authTimeoutMs: opts.authTimeoutMs ?? 60_000,
    meterFlushIntervalMs: opts.meterFlushIntervalMs ?? 0,
    minClientVersion: opts.minClientVersion,
    isLocalUserAuthenticated: opts.isLocalUserAuthenticated,
    clientIp: opts.clientIp ?? (() => '127.0.0.1'),
    sleep: () => Promise.resolve(),
    log: () => {},
  });
  const harness: RelayHarness = {
    runtime,
    db,
    adminToken: RELAY_TEST_ADMIN_TOKEN,
    now: () => now(),
    advance(ms) {
      clock += ms;
    },
    async fetch(path, init) {
      const res = await runtime.handleRequest(new Request(`${BASE}${path}`, init), upgradeServer());
      return res ?? new Response(null, { status: 204 });
    },
    adminFetch(path, init) {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${RELAY_TEST_ADMIN_TOKEN}`);
      if (init?.body && !headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
      return harness.fetch(path, { ...init, headers });
    },
    tenantFetch(path, token, init) {
      const headers = new Headers(init?.headers);
      headers.set(RELAY_TOKEN_HEADER, token);
      if (init?.body && !headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
      return harness.fetch(path, { ...init, headers });
    },
    createTenant(tenantOpts) {
      return createTenant(harness, now, tenantOpts);
    },
    async close() {
      await runtime.stop();
      close();
    },
  };
  if (opts.password) {
    const res = await harness.adminFetch('/api/relay/password', {
      method: 'POST',
      body: JSON.stringify({ password: opts.password, mode: 'keep' }),
    });
    if (!res.ok) throw new Error(`failed to set relay password: ${res.status}`);
  }
  return harness;
}

async function createTenant(
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
  });
}

function makeTenantHandle(
  harness: RelayHarness,
  now: () => number,
  base: { id: string; token: string; passwordEpoch: number; root: RootKey; uid: string }
): RelayTenantHandle {
  let head: { seq: bigint; hash: Uint8Array } = { seq: 0n, hash: new Uint8Array(32) };
  const signRecord = (
    type: 'admit-node' | 'revoke-node',
    payload: Uint8Array,
    signer: 'root' | 'passkey'
  ): { bytes: string; sig: string } => {
    const record = buildKeyLogRecord(head, 0, {
      uid: base.uid,
      type,
      payload,
      signer,
      credential_id: signer === 'passkey' ? 'test-credential' : null,
    });
    const bytes = encodeKeyLogRecord(record);
    const sig = signer === 'root' ? signKeyLogRecordWithRoot(base.root, bytes) : new Uint8Array(64);
    head = { seq: record.seq, hash: computeRecordHash(bytes, sig) };
    return { bytes: encodeBase64url(bytes), sig: encodeBase64url(sig) };
  };
  return {
    id: base.id,
    token: base.token,
    root: base.root,
    uid: base.uid,
    passwordEpoch: base.passwordEpoch,
    addNode(opts) {
      const ed = generateEd25519KeyPair();
      const x25519 = generateX25519KeyPair();
      const enroll = generateEd25519KeyPair();
      const cert = createNodeCertificate(enroll.secretKey, {
        uid: base.uid,
        edPk: ed.publicKey,
        x25519Pk: x25519.publicKey,
        enrollPk: enroll.publicKey,
        now: now(),
      });
      const authorizationBytes = encodeAuthorization({
        domain: DOMAIN_AUTHORIZATION,
        uid: base.uid,
        enroll_pk: enroll.publicKey,
        exp: BigInt(now() + 600_000),
        root_epoch: 0,
        signer: 'root',
        credential_id: null,
      });
      const authorizationSig = base.root.sign(authorizationBytes);
      const admit = signRecord(
        'admit-node',
        encodeAdmitNodePayload({
          authorization_bytes: authorizationBytes,
          authorization_sig: authorizationSig,
          certificate_bytes: cert.certificateBytes,
          cert_sig: cert.certSig,
        }),
        opts?.admitSigner ?? 'root'
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
