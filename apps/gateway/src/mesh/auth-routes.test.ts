import { describe, expect, test } from 'bun:test';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import {
  DELEGATION_TTL_MS,
  buildLogin,
  buildPasskeyDelegation,
  createDelegation,
  decodeBase64url,
  encodeBase64url,
  encodeClearTotpPayload,
  encodeDelegation,
  encodeLogin,
  encodeSetTotpPayload,
  encryptTotpSecret,
  generateEd25519KeyPair,
  sha256,
  signLogin,
  totpCode,
} from '@tmex/shared/auth';
import type { LinkSession } from '@tmex/shared/link';
import { ChallengeStore } from '../auth/challenge-store';
import { KeyLogStore } from '../auth/key-log-store';
import { NodeSessionStore } from '../auth/node-session-store';
import { encodePasskeyAssertionSig, verifyRegistration } from '../auth/passkey';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserKeyService } from '../auth/user-key-service';
import { UserStore } from '../auth/user-store';
import type { AuthKeyLogPublisher } from './auth-routes';
import {
  type MeshRtcDeps,
  type OpenedWsStream,
  type PeerLinkProvider,
  type StreamOpener,
  X_TMEX_SET_SESSION,
  isMeshRewritten,
  setMeshRequestContext,
} from './mesh-deps';
import { MeshHttpRuntime } from './mesh-http';
import { NodeUnreachableError } from './types';

// biome-ignore lint/suspicious/noExportsInTest: shared harness
export const NODE_ID = 'aa'.repeat(16);
// biome-ignore lint/suspicious/noExportsInTest: shared harness
export const NODE_PK = Uint8Array.from({ length: 32 }, () => 9);
// biome-ignore lint/suspicious/noExportsInTest: shared harness
export const PASSWORD = 'tmex-test';

// biome-ignore lint/suspicious/noExportsInTest: shared harness
export class FakePeers implements PeerLinkProvider {
  readonly links = new Map<string, LinkSession>();
  readonly reach = new Map<string, 'lan' | 'relay' | null>();
  readonly listeners = new Set<
    (e: { nodeId: string; status: 'online' | 'offline' | 'revoked' }) => void
  >();

  async getLink(nodeId: string): Promise<LinkSession> {
    const link = this.links.get(nodeId);
    if (!link) throw new NodeUnreachableError(nodeId);
    return link;
  }

  listReach(): Map<string, 'lan' | 'relay' | null> {
    return this.reach;
  }

  onNodeEvent(
    cb: (e: { nodeId: string; status: 'online' | 'offline' | 'revoked' }) => void
  ): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emit(event: { nodeId: string; status: 'online' | 'offline' | 'revoked' }): void {
    for (const cb of this.listeners) cb(event);
  }
}

// biome-ignore lint/suspicious/noExportsInTest: shared harness
export class FakeWs implements OpenedWsStream {
  readonly sent: Uint8Array[] = [];
  private msg: Array<(b: Uint8Array) => void> = [];
  private closed: Array<(info: { code?: number; reason?: string }) => void> = [];

  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
  }
  onMessage(cb: (bytes: Uint8Array) => void): void {
    this.msg.push(cb);
  }
  onClose(cb: (info: { code?: number; reason?: string }) => void): void {
    this.closed.push(cb);
  }
  close(code?: number, reason?: string): void {
    for (const cb of this.closed) cb({ code, reason });
  }
  pushFromRemote(bytes: Uint8Array): void {
    for (const cb of this.msg) cb(bytes);
  }
}

// biome-ignore lint/suspicious/noExportsInTest: shared harness
export class FakeStreams implements StreamOpener {
  lastOpen: {
    path: string;
    headers: Record<string, string>;
    auth: string | null;
    method: string;
  } | null = null;
  nextResponse: Response = new Response('ok');
  lastWs: FakeWs | null = null;
  wsAuth: string | null = null;

  async openHttpStream(
    _link: LinkSession,
    open: {
      method: string;
      path: string;
      query: string;
      headers: Record<string, string>;
      origin: string;
      auth: string | null;
    },
    _body: ReadableStream<Uint8Array> | null,
    _signal: AbortSignal
  ): Promise<Response> {
    this.lastOpen = {
      path: open.path,
      headers: open.headers,
      auth: open.auth,
      method: open.method,
    };
    return this.nextResponse;
  }

  async openWsStream(_link: LinkSession, auth: string): Promise<OpenedWsStream> {
    this.wsAuth = auth;
    this.lastWs = new FakeWs();
    return this.lastWs;
  }
}

// biome-ignore lint/suspicious/noExportsInTest: shared harness
export const dummyServer = { upgrade: () => true };

// biome-ignore lint/suspicious/noExportsInTest: shared harness
export async function bootMesh(options?: {
  roles?: { hub: boolean; node: boolean };
  now?: () => number;
  peers?: FakePeers;
  streams?: FakeStreams;
  rtc?: MeshRtcDeps;
  publisher?: AuthKeyLogPublisher;
}) {
  const { db, close } = createMigratedAuthDb();
  const userStore = new UserStore(db);
  const keyLogStore = new KeyLogStore(db);
  const nodeSessionStore = new NodeSessionStore(db);
  const keyLogService = new UserKeyService({ db, userStore, keyLogStore, nodeSessionStore });
  const boot = await keyLogService.bootstrapUser({ username: 'alice', password: PASSWORD });
  const challengeStore = new ChallengeStore({ now: options?.now });
  const peers = options?.peers ?? new FakePeers();
  const streams = options?.streams ?? new FakeStreams();
  const published: Array<{ bytes: Uint8Array; sig: Uint8Array }> = [];
  const runtime = new MeshHttpRuntime({
    roles: options?.roles ?? { hub: false, node: true },
    nodeId: NODE_ID,
    nodePk: NODE_PK,
    userStore,
    keyLogService,
    challengeStore,
    nodeSessionStore,
    peers,
    streams,
    publisher: options?.publisher ?? {
      publish(record) {
        published.push(record);
      },
    },
    rtc: options?.rtc,
    now: options?.now,
    primaryUserId: boot.userId,
  });
  return {
    close,
    runtime,
    userStore,
    keyLogService,
    nodeSessionStore,
    challengeStore,
    peers,
    streams,
    published,
    boot,
  };
}

// biome-ignore lint/suspicious/noExportsInTest: shared harness
export async function call(
  runtime: MeshHttpRuntime,
  url: string,
  init?: RequestInit & {
    via?: string;
    clientIp?: string;
    authSid?: string;
    trustProxy?: boolean;
  }
): Promise<Response> {
  const req = new Request(url, init);
  if (init?.via || init?.clientIp || init?.authSid || init?.trustProxy) {
    setMeshRequestContext(req, {
      via: init.via ?? 'self',
      clientIp: init.clientIp,
      auth: init.authSid,
      trustProxy: init.trustProxy,
    });
  }
  let res = await runtime.handleRequest(req, dummyServer);
  if (isMeshRewritten(res)) {
    res = await runtime.handleRequest(res.rewritten, dummyServer);
  }
  if (res == null || !(res instanceof Response)) {
    throw new Error(`unhandled ${url}`);
  }
  return res;
}

// biome-ignore lint/suspicious/noExportsInTest: shared harness
export function asResponse(res: unknown): Response {
  if (!(res instanceof Response)) {
    throw new Error('expected Response');
  }
  return res;
}

// biome-ignore lint/suspicious/noExportsInTest: shared harness
export function sidFromLogin(res: Response): string {
  const internal = res.headers.get(X_TMEX_SET_SESSION);
  if (internal) {
    const sid = internal.split(';')[0]?.trim();
    if (sid) return sid;
  }
  const cookie = res.headers.get('set-cookie') ?? '';
  const match = cookie.match(/tmex_s_self=([^;]*)/);
  if (match?.[1]) return match[1];
  throw new Error('login response did not carry a sid');
}

// biome-ignore lint/suspicious/noExportsInTest: shared harness
export async function challengeAndLogin(
  runtime: MeshHttpRuntime,
  boot: { userId: string; rootKey: Parameters<typeof createDelegation>[0] },
  tweak?: {
    entry?: string;
    target?: string;
    targetPk?: Uint8Array;
    badSig?: boolean;
    totp?: { code: string; k_totp: string };
    via?: string;
    reuseChallenge?: { challenge_id: string; nonce: Uint8Array };
    issuedAt?: number;
    clientIp?: string;
  }
) {
  const sess = generateEd25519KeyPair();
  const issuedAt = tweak?.issuedAt ?? Date.now();
  const del = createDelegation(boot.rootKey, {
    uid: boot.userId,
    sessPk: sess.publicKey,
    now: issuedAt,
  });
  let challengeId: string;
  let nonce: Uint8Array;
  if (tweak?.reuseChallenge) {
    challengeId = tweak.reuseChallenge.challenge_id;
    nonce = tweak.reuseChallenge.nonce;
  } else {
    const ch = await call(runtime, 'http://localhost/api/auth/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uid: boot.userId }),
      via: tweak?.via,
      clientIp: tweak?.clientIp,
    });
    const body = (await ch.json()) as { challenge_id: string; nonce: string };
    challengeId = body.challenge_id;
    nonce = decodeBase64url(body.nonce);
  }
  const login = buildLogin({
    challengeId,
    nonce,
    target: tweak?.target ?? NODE_ID,
    targetPk: tweak?.targetPk ?? NODE_PK,
    uid: boot.userId,
    entry: tweak?.entry ?? tweak?.via ?? 'self',
  });
  let sig = signLogin(sess.secretKey, login);
  if (tweak?.badSig) {
    sig = new Uint8Array(sig);
    sig[0] = (sig[0] ?? 0) ^ 0xff;
  }
  const res = await call(runtime, 'http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      login: encodeBase64url(encodeLogin(login)),
      sig: encodeBase64url(sig),
      delegation: encodeBase64url(del.bytes),
      delegation_sig: encodeBase64url(del.sig),
      ...(tweak?.totp ? { totp: tweak.totp } : {}),
    }),
    via: tweak?.via,
    clientIp: tweak?.clientIp,
  });
  return { res, sid: res.ok ? sidFromLogin(res) : '', challengeId, nonce, del };
}

function insertPasskeyRow(
  userStore: UserStore,
  userId: string,
  opts: { origin: string; rpId: string; fill: number; name?: string }
): Uint8Array {
  const credentialId = new Uint8Array(16).fill(opts.fill);
  userStore.insertKey({
    id: crypto.randomUUID(),
    userId,
    credentialId,
    publicKey: new Uint8Array(32).fill(opts.fill),
    rpId: opts.rpId,
    origin: opts.origin,
    counter: 0,
    name: opts.name ?? `key-${opts.fill}`,
    logSeq: 1,
    now: Date.now(),
  });
  return credentialId;
}

async function requestPasskeyLoginOptions(
  mesh: Awaited<ReturnType<typeof bootMesh>>,
  origin: string | null,
  extra?: {
    headers?: Record<string, string>;
    trustProxy?: boolean;
    via?: string;
  }
): Promise<Response> {
  const sess = generateEd25519KeyPair();
  const del = createDelegation(mesh.boot.rootKey, {
    uid: mesh.boot.userId,
    sessPk: sess.publicKey,
    now: Date.now(),
  });
  return call(mesh.runtime, 'http://127.0.0.1:19663/api/auth/passkey/login/options', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
      ...extra?.headers,
    },
    body: JSON.stringify({
      uid: mesh.boot.userId,
      delegation: encodeBase64url(encodeDelegation(del.delegation)),
    }),
    via: extra?.via,
    trustProxy: extra?.trustProxy,
  });
}

describe('auth-routes', () => {
  test('GET /api/auth/mode mesh + standalone none', async () => {
    const mesh = await bootMesh();
    try {
      const res = await call(mesh.runtime, 'http://localhost/api/auth/mode', {
        headers: { origin: 'http://localhost:19663' },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        mode: string;
        nodeId: string;
        uid: string;
        username: string;
        kdfParams: { salt: string; memory_kib: number };
        passkeysForThisOrigin: boolean;
        passkeyAvailable: boolean;
        totpEnabled: boolean;
        rootEpoch: number | null;
        rootPublicKey: string | null;
        hubNodeId: string | null;
        hubPublicUrl: string | null;
      };
      expect(body.mode).toBe('mesh');
      expect(body.nodeId).toBe(NODE_ID);
      expect(body.username).toBe('alice');
      expect(body.uid).toBe(mesh.boot.userId);
      expect(body.kdfParams.memory_kib).toBe(65536);
      expect(body.passkeysForThisOrigin).toBe(false);
      expect(body.passkeyAvailable).toBe(true);
      expect(body.totpEnabled).toBe(false);
      expect(body.rootEpoch).toBe(mesh.boot.rootEpoch);
      expect(body.rootPublicKey).toBe(encodeBase64url(mesh.boot.rootPublicKey));
      expect(body.hubNodeId).toBeNull();
      expect(body.hubPublicUrl).toBeNull();
    } finally {
      mesh.close();
    }

    const standalone = await bootMesh({ roles: { hub: false, node: false } });
    try {
      const res = await call(standalone.runtime, 'http://localhost/api/auth/mode');
      const body = (await res.json()) as { mode: string };
      expect(body.mode).toBe('none');
    } finally {
      standalone.close();
    }
  });

  test('GET /api/auth/mode reports persisted hub meta and roles.hub', async () => {
    const mesh = await bootMesh();
    try {
      mesh.userStore.upsertHubMeta({
        nodeId: 'bb'.repeat(16),
        publicUrl: 'https://hub.example',
        now: Date.now(),
      });
      const res = await call(mesh.runtime, 'http://localhost/api/auth/mode');
      const body = (await res.json()) as { hubNodeId: string; hubPublicUrl: string };
      expect(body.hubNodeId).toBe('bb'.repeat(16));
      expect(body.hubPublicUrl).toBe('https://hub.example');
    } finally {
      mesh.close();
    }

    const hub = await bootMesh({ roles: { hub: true, node: true } });
    try {
      const runtime = new MeshHttpRuntime({
        roles: { hub: true, node: true },
        nodeId: NODE_ID,
        nodePk: NODE_PK,
        userStore: hub.userStore,
        keyLogService: hub.keyLogService,
        challengeStore: hub.challengeStore,
        nodeSessionStore: hub.nodeSessionStore,
        peers: hub.peers,
        streams: hub.streams,
        publisher: { publish() {} },
        primaryUserId: hub.boot.userId,
        hubPublicUrl: 'https://hub.local',
      });
      const res = await call(runtime, 'http://localhost/api/auth/mode');
      const body = (await res.json()) as { hubNodeId: string; hubPublicUrl: string };
      expect(body.hubNodeId).toBe(NODE_ID);
      expect(body.hubPublicUrl).toBe('https://hub.local');
      runtime.stop();
    } finally {
      hub.close();
    }
  });

  test('GET /api/auth/keylog/head and /api/auth/passkeys require session', async () => {
    const mesh = await bootMesh();
    try {
      const deniedHead = await call(mesh.runtime, 'http://localhost/api/auth/keylog/head');
      expect(deniedHead.status).toBe(401);
      const deniedKeys = await call(mesh.runtime, 'http://localhost/api/auth/passkeys');
      expect(deniedKeys.status).toBe(401);

      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const cookie = { headers: { cookie: `tmex_s_self=${sid}` } };
      const head = await call(mesh.runtime, 'http://localhost/api/auth/keylog/head', cookie);
      expect(head.status).toBe(200);
      const headBody = (await head.json()) as {
        seq: number;
        hash: string;
        rootEpoch: number;
        uid: string;
      };
      const state = mesh.keyLogService.currentState(mesh.boot.userId);
      expect(headBody.seq).toBe(Number(state.head.seq));
      expect(headBody.hash).toBe(encodeBase64url(state.head.hash));
      expect(headBody.rootEpoch).toBe(mesh.boot.rootEpoch);
      expect(headBody.uid).toBe(mesh.boot.userId);

      mesh.userStore.insertKey({
        id: crypto.randomUUID(),
        userId: mesh.boot.userId,
        credentialId: new Uint8Array(16).fill(3),
        publicKey: new Uint8Array(32).fill(4),
        rpId: 'localhost',
        origin: 'http://localhost:19663',
        counter: 0,
        name: 'laptop',
        logSeq: 2,
        now: 1_700,
      });
      const keys = await call(mesh.runtime, 'http://localhost/api/auth/passkeys', cookie);
      const keysBody = (await keys.json()) as {
        passkeys: Array<{
          credential_id: string;
          name: string | null;
          rp_id: string;
          origin: string;
          created_at: number;
          log_seq: number;
        }>;
      };
      expect(keysBody.passkeys).toHaveLength(1);
      expect(keysBody.passkeys[0]?.name).toBe('laptop');
      expect(keysBody.passkeys[0]?.rp_id).toBe('localhost');
      expect(keysBody.passkeys[0]?.log_seq).toBe(2);
      expect(keysBody.passkeys[0]?.created_at).toBe(1_700);
    } finally {
      mesh.close();
    }
  });

  test('POST /api/auth/keylog?hub=sync acks hub first then applies locally', async () => {
    const mesh = await bootMesh();
    try {
      const acked: Array<{ bytes: Uint8Array; sig: Uint8Array }> = [];
      const runtime = new MeshHttpRuntime({
        roles: { hub: false, node: true },
        nodeId: NODE_ID,
        nodePk: NODE_PK,
        userStore: mesh.userStore,
        keyLogService: mesh.keyLogService,
        challengeStore: mesh.challengeStore,
        nodeSessionStore: mesh.nodeSessionStore,
        peers: mesh.peers,
        streams: mesh.streams,
        publisher: {
          publish() {},
          async publishAndAck(record) {
            acked.push(record);
            return { ok: true, seq: 2n };
          },
        },
        primaryUserId: mesh.boot.userId,
      });
      const { sid } = await challengeAndLogin(runtime, mesh.boot);
      const { buildKeyLogRecord, encodeKeyLogRecord, signKeyLogRecordWithRoot } = await import(
        '@tmex/shared/auth'
      );
      const state = mesh.keyLogService.currentState(mesh.boot.userId);
      const rec = buildKeyLogRecord(state.head, state.rootEpoch, {
        uid: mesh.boot.userId,
        type: 'clear-totp',
        payload: encodeClearTotpPayload(),
        signer: 'root',
        credential_id: null,
      });
      const bytes = encodeKeyLogRecord(rec);
      const sig = signKeyLogRecordWithRoot(mesh.boot.rootKey, bytes);
      const ok = await call(runtime, 'http://localhost/api/auth/keylog?hub=sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `tmex_s_self=${sid}`,
        },
        body: JSON.stringify({
          bytes: encodeBase64url(bytes),
          sig: encodeBase64url(sig),
        }),
      });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { ok: boolean; hubAck: boolean; seq: number };
      expect(body.ok).toBe(true);
      expect(body.hubAck).toBe(true);
      expect(acked).toHaveLength(1);
      expect(mesh.keyLogService.currentState(mesh.boot.userId).head.seq).toBe(state.head.seq + 1n);
      runtime.stop();
    } finally {
      mesh.close();
    }
  });

  test('hub=sync hub rejection does not persist a forking record', async () => {
    const mesh = await bootMesh();
    try {
      const runtime = new MeshHttpRuntime({
        roles: { hub: false, node: true },
        nodeId: NODE_ID,
        nodePk: NODE_PK,
        userStore: mesh.userStore,
        keyLogService: mesh.keyLogService,
        challengeStore: mesh.challengeStore,
        nodeSessionStore: mesh.nodeSessionStore,
        peers: mesh.peers,
        streams: mesh.streams,
        publisher: {
          publish() {},
          async publishAndAck() {
            return { ok: false, error: 'fork' };
          },
        },
        primaryUserId: mesh.boot.userId,
      });
      const { sid } = await challengeAndLogin(runtime, mesh.boot);
      const { buildKeyLogRecord, encodeKeyLogRecord, signKeyLogRecordWithRoot } = await import(
        '@tmex/shared/auth'
      );
      const state = mesh.keyLogService.currentState(mesh.boot.userId);
      const rec = buildKeyLogRecord(state.head, state.rootEpoch, {
        uid: mesh.boot.userId,
        type: 'clear-totp',
        payload: encodeClearTotpPayload(),
        signer: 'root',
        credential_id: null,
      });
      const bytes = encodeKeyLogRecord(rec);
      const sig = signKeyLogRecordWithRoot(mesh.boot.rootKey, bytes);
      const res = await call(runtime, 'http://localhost/api/auth/keylog?hub=sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `tmex_s_self=${sid}`,
        },
        body: JSON.stringify({
          bytes: encodeBase64url(bytes),
          sig: encodeBase64url(sig),
        }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('fork');
      expect(mesh.keyLogService.currentState(mesh.boot.userId).head.seq).toBe(state.head.seq);
      runtime.stop();
    } finally {
      mesh.close();
    }
  });

  test('node role POST /api/auth/keylog defaults to hub-sync', async () => {
    const mesh = await bootMesh();
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const { buildKeyLogRecord, encodeKeyLogRecord, signKeyLogRecordWithRoot } = await import(
        '@tmex/shared/auth'
      );
      const state = mesh.keyLogService.currentState(mesh.boot.userId);
      const rec = buildKeyLogRecord(state.head, state.rootEpoch, {
        uid: mesh.boot.userId,
        type: 'clear-totp',
        payload: encodeClearTotpPayload(),
        signer: 'root',
        credential_id: null,
      });
      const bytes = encodeKeyLogRecord(rec);
      const sig = signKeyLogRecordWithRoot(mesh.boot.rootKey, bytes);
      const res = await call(mesh.runtime, 'http://localhost/api/auth/keylog', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `tmex_s_self=${sid}`,
        },
        body: JSON.stringify({
          bytes: encodeBase64url(bytes),
          sig: encodeBase64url(sig),
        }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('unavailable');
      expect(mesh.keyLogService.currentState(mesh.boot.userId).head.seq).toBe(state.head.seq);
      expect(mesh.published).toHaveLength(0);
    } finally {
      mesh.close();
    }
  });

  test('hub=sync timeout retries then treats matching hub head as acked', async () => {
    const mesh = await bootMesh();
    try {
      const { buildKeyLogRecord, computeRecordHash, encodeKeyLogRecord, signKeyLogRecordWithRoot } =
        await import('@tmex/shared/auth');
      const state = mesh.keyLogService.currentState(mesh.boot.userId);
      const rec = buildKeyLogRecord(state.head, state.rootEpoch, {
        uid: mesh.boot.userId,
        type: 'clear-totp',
        payload: encodeClearTotpPayload(),
        signer: 'root',
        credential_id: null,
      });
      const bytes = encodeKeyLogRecord(rec);
      const sig = signKeyLogRecordWithRoot(mesh.boot.rootKey, bytes);
      const hash = computeRecordHash(bytes, sig);
      let calls = 0;
      const runtime = new MeshHttpRuntime({
        roles: { hub: false, node: true },
        nodeId: NODE_ID,
        nodePk: NODE_PK,
        userStore: mesh.userStore,
        keyLogService: mesh.keyLogService,
        challengeStore: mesh.challengeStore,
        nodeSessionStore: mesh.nodeSessionStore,
        peers: mesh.peers,
        streams: mesh.streams,
        publisher: {
          publish() {},
          async publishAndAck() {
            calls += 1;
            return { ok: false, error: 'timeout' };
          },
          async queryHubHead() {
            return { seq: rec.seq, hash };
          },
        },
        primaryUserId: mesh.boot.userId,
      });
      const { sid } = await challengeAndLogin(runtime, mesh.boot);
      const ok = await call(runtime, 'http://localhost/api/auth/keylog?hub=sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `tmex_s_self=${sid}`,
        },
        body: JSON.stringify({
          bytes: encodeBase64url(bytes),
          sig: encodeBase64url(sig),
        }),
      });
      expect(ok.status).toBe(200);
      expect(calls).toBe(2);
      expect(((await ok.json()) as { hubAck: boolean }).hubAck).toBe(true);
      expect(mesh.keyLogService.currentState(mesh.boot.userId).head.seq).toBe(state.head.seq + 1n);
      runtime.stop();
    } finally {
      mesh.close();
    }
  });

  test('hub=sync timeout then mismatched hub head returns 504 HUB_TIMEOUT', async () => {
    const mesh = await bootMesh();
    try {
      const runtime = new MeshHttpRuntime({
        roles: { hub: false, node: true },
        nodeId: NODE_ID,
        nodePk: NODE_PK,
        userStore: mesh.userStore,
        keyLogService: mesh.keyLogService,
        challengeStore: mesh.challengeStore,
        nodeSessionStore: mesh.nodeSessionStore,
        peers: mesh.peers,
        streams: mesh.streams,
        publisher: {
          publish() {},
          async publishAndAck() {
            return { ok: false, error: 'timeout' };
          },
          async queryHubHead() {
            return { seq: 99n, hash: new Uint8Array(32).fill(9) };
          },
        },
        primaryUserId: mesh.boot.userId,
      });
      const { sid } = await challengeAndLogin(runtime, mesh.boot);
      const { buildKeyLogRecord, encodeKeyLogRecord, signKeyLogRecordWithRoot } = await import(
        '@tmex/shared/auth'
      );
      const state = mesh.keyLogService.currentState(mesh.boot.userId);
      const rec = buildKeyLogRecord(state.head, state.rootEpoch, {
        uid: mesh.boot.userId,
        type: 'clear-totp',
        payload: encodeClearTotpPayload(),
        signer: 'root',
        credential_id: null,
      });
      const bytes = encodeKeyLogRecord(rec);
      const sig = signKeyLogRecordWithRoot(mesh.boot.rootKey, bytes);
      const res = await call(runtime, 'http://localhost/api/auth/keylog?hub=sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `tmex_s_self=${sid}`,
        },
        body: JSON.stringify({
          bytes: encodeBase64url(bytes),
          sig: encodeBase64url(sig),
        }),
      });
      expect(res.status).toBe(504);
      expect((await res.json()).code).toBe('HUB_TIMEOUT');
      expect(mesh.keyLogService.currentState(mesh.boot.userId).head.seq).toBe(state.head.seq);
      runtime.stop();
    } finally {
      mesh.close();
    }
  });

  test('login happy path sets cookie + x-tmex-set-session', async () => {
    const mesh = await bootMesh();
    try {
      const { res, sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sid?: string; expires_at: number };
      expect(body.sid).toBeUndefined();
      expect(body.expires_at).toBeGreaterThan(Date.now());
      expect(res.headers.get('x-tmex-set-session')).toBeNull();
      const cookie = res.headers.get('set-cookie') ?? '';
      expect(cookie).toContain(`tmex_s_self=${sid}`);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/');
      expect(sid.length).toBeGreaterThan(10);
    } finally {
      mesh.close();
    }
  });

  test('login via remote entry does not Set-Cookie, only x-tmex-set-session', async () => {
    const mesh = await bootMesh();
    try {
      const { res } = await challengeAndLogin(mesh.runtime, mesh.boot, {
        via: 'entry-node',
        entry: 'entry-node',
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(res.headers.get('x-tmex-set-session')).toBeTruthy();
    } finally {
      mesh.close();
    }
  });

  test('failure codes: consumed challenge, wrong entry, wrong target_pk, expired delegation, bad sig', async () => {
    const mesh = await bootMesh();
    try {
      const first = await challengeAndLogin(mesh.runtime, mesh.boot);
      expect(first.res.status).toBe(200);
      const replay = await challengeAndLogin(mesh.runtime, mesh.boot, {
        reuseChallenge: { challenge_id: first.challengeId, nonce: first.nonce },
      });
      expect(replay.res.status).toBe(401);
      expect((await replay.res.json()).code).toBe('CHALLENGE_CONSUMED');

      const entry = await challengeAndLogin(mesh.runtime, mesh.boot, { entry: 'other-entry' });
      expect((await entry.res.json()).code).toBe('ENTRY_MISMATCH');

      const pk = await challengeAndLogin(mesh.runtime, mesh.boot, {
        targetPk: new Uint8Array(32).fill(1),
      });
      expect((await pk.res.json()).code).toBe('TARGET_MISMATCH');

      const expired = await challengeAndLogin(mesh.runtime, mesh.boot, {
        issuedAt: Date.now() - DELEGATION_TTL_MS - 2000,
      });
      expect((await expired.res.json()).code).toBe('DELEGATION_EXPIRED');

      const bad = await challengeAndLogin(mesh.runtime, mesh.boot, { badSig: true });
      expect((await bad.res.json()).code).toBe('BAD_SIGNATURE');
    } finally {
      mesh.close();
    }
  });

  test('wrong TOTP rejected; missing TOTP required when enabled', async () => {
    const mesh = await bootMesh();
    try {
      const { deriveSeed, deriveTotpKey } = await import('@tmex/shared/auth');
      const { kdfParamsFromJson } = await import('../auth/user-key-service');
      const state = mesh.keyLogService.currentState(mesh.boot.userId);
      const secret = new Uint8Array(20).fill(7);
      const user = mesh.userStore.getById(mesh.boot.userId);
      if (!user) throw new Error('missing user');
      const params = kdfParamsFromJson(user.kdfParamsJson);
      const seed = await deriveSeed(PASSWORD, params);
      const kTotp = deriveTotpKey(seed, mesh.boot.userId, state.rootEpoch);
      const payload = await encryptTotpSecret(kTotp, secret, {
        uid: mesh.boot.userId,
        root_epoch: state.rootEpoch,
        seq: state.head.seq + 1n,
      });
      const applied = await mesh.keyLogService.signAndApply(mesh.boot.userId, mesh.boot.rootKey, {
        type: 'set-totp',
        payload: encodeSetTotpPayload(payload),
      });
      expect(applied.ok).toBe(true);

      const missing = await challengeAndLogin(mesh.runtime, mesh.boot);
      expect((await missing.res.json()).code).toBe('TOTP_REQUIRED');

      const wrong = await challengeAndLogin(mesh.runtime, mesh.boot, {
        totp: { code: '000000', k_totp: encodeBase64url(kTotp) },
      });
      expect((await wrong.res.json()).code).toBe('TOTP_INVALID');

      const code = totpCode(secret, Math.floor(Date.now() / 1000));
      const ok = await challengeAndLogin(mesh.runtime, mesh.boot, {
        totp: { code, k_totp: encodeBase64url(kTotp) },
      });
      expect(ok.res.status).toBe(200);
    } finally {
      mesh.close();
    }
  });

  test('rate limit 10 failures per uid / ip → 429', async () => {
    const mesh = await bootMesh();
    try {
      for (let i = 0; i < 10; i++) {
        const { res } = await challengeAndLogin(mesh.runtime, mesh.boot, {
          badSig: true,
          clientIp: '10.0.0.9',
        });
        expect(res.status).toBe(401);
      }
      const { res } = await challengeAndLogin(mesh.runtime, mesh.boot, {
        badSig: true,
        clientIp: '10.0.0.9',
      });
      expect(res.status).toBe(429);
      expect((await res.json()).code).toBe('RATE_LIMITED');
    } finally {
      mesh.close();
    }
  });

  test('passkey register/options requires session; login/options returns publicKey options', async () => {
    const mesh = await bootMesh();
    try {
      const denied = await call(
        mesh.runtime,
        'http://localhost/api/auth/passkey/register/options',
        {
          method: 'POST',
        }
      );
      expect(denied.status).toBe(401);

      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const opts = await call(mesh.runtime, 'http://localhost/api/auth/passkey/register/options', {
        method: 'POST',
        headers: { cookie: `tmex_s_self=${sid}`, origin: 'http://localhost:19663' },
      });
      expect(opts.status).toBe(200);
      const body = (await opts.json()) as {
        challenge: string;
        rp: { id: string };
        challenge_id: string;
      };
      expect(body.rp.id).toBe('localhost');
      expect(body.challenge_id).toBeTruthy();

      const { encodeDelegation } = await import('@tmex/shared/auth');
      const sess = generateEd25519KeyPair();
      const del = createDelegation(mesh.boot.rootKey, {
        uid: mesh.boot.userId,
        sessPk: sess.publicKey,
        now: Date.now(),
      });
      const loginOpts = await call(
        mesh.runtime,
        'http://localhost/api/auth/passkey/login/options',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://localhost:19663' },
          body: JSON.stringify({
            uid: mesh.boot.userId,
            delegation: encodeBase64url(encodeDelegation(del.delegation)),
          }),
        }
      );
      expect(loginOpts.status).toBe(404);
      expect((await loginOpts.json()).code).toBe('NO_PASSKEY_FOR_ORIGIN');
    } finally {
      mesh.close();
    }
  });

  test('logout revokes sessions and clears cookie', async () => {
    const mesh = await bootMesh();
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const out = await call(mesh.runtime, 'http://localhost/api/auth/logout', {
        method: 'POST',
        headers: { cookie: `tmex_s_self=${sid}` },
      });
      expect(out.status).toBe(200);
      expect(out.headers.get('set-cookie') ?? '').toContain('Max-Age=0');
      expect(out.headers.get('x-tmex-set-session')).toBeNull();
      expect(mesh.nodeSessionStore.verify(sid, { viaNodeId: 'self', now: Date.now() }).ok).toBe(
        false
      );
    } finally {
      mesh.close();
    }
  });

  test('keylog apply forwards to publisher; fork → 409', async () => {
    const mesh = await bootMesh({ roles: { hub: true, node: true } });
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const { buildKeyLogRecord, encodeKeyLogRecord, signKeyLogRecordWithRoot } = await import(
        '@tmex/shared/auth'
      );
      const state = mesh.keyLogService.currentState(mesh.boot.userId);
      const recA = buildKeyLogRecord(state.head, state.rootEpoch, {
        uid: mesh.boot.userId,
        type: 'clear-totp',
        payload: encodeClearTotpPayload(),
        signer: 'root',
        credential_id: null,
      });
      const bytesA = encodeKeyLogRecord(recA);
      const sigA = signKeyLogRecordWithRoot(mesh.boot.rootKey, bytesA);
      const ok = await call(mesh.runtime, 'http://localhost/api/auth/keylog', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `tmex_s_self=${sid}`,
        },
        body: JSON.stringify({
          bytes: encodeBase64url(bytesA),
          sig: encodeBase64url(sigA),
        }),
      });
      expect(ok.status).toBe(200);
      expect(mesh.published).toHaveLength(1);

      const recB = buildKeyLogRecord(state.head, state.rootEpoch, {
        uid: mesh.boot.userId,
        type: 'set-totp',
        payload: encodeSetTotpPayload({
          alg: 'A256GCM',
          nonce: new Uint8Array(12).fill(1),
          ciphertext: new Uint8Array(4).fill(2),
          tag: new Uint8Array(16).fill(3),
        }),
        signer: 'root',
        credential_id: null,
      });
      const bytesB = encodeKeyLogRecord(recB);
      const sigB = signKeyLogRecordWithRoot(mesh.boot.rootKey, bytesB);
      const forkRes = await call(mesh.runtime, 'http://localhost/api/auth/keylog', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `tmex_s_self=${sid}`,
        },
        body: JSON.stringify({
          bytes: encodeBase64url(bytesB),
          sig: encodeBase64url(sigB),
        }),
      });
      expect(forkRes.status).toBe(409);
      expect((await forkRes.json()).code).toBe('KEY_LOG_FORK');
    } finally {
      mesh.close();
    }
  });

  test('GET /api/auth/nodes is public and returns only id/name/online', async () => {
    const mesh = await bootMesh();
    try {
      const res = await call(mesh.runtime, 'http://localhost/api/auth/nodes');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { nodes: Array<Record<string, unknown>> };
      expect(body.nodes.length).toBeGreaterThan(0);
      for (const node of body.nodes) {
        expect(Object.keys(node).sort()).toEqual(['id', 'name', 'online']);
      }
    } finally {
      mesh.close();
    }
  });

  test('passkey login uses Borsh PasskeyAssertion and binds storedKey.userId', async () => {
    const mesh = await bootMesh();
    try {
      const authenticator = await createEs256Authenticator();
      const origin = 'http://localhost:19663';
      const rpId = 'localhost';
      const challenge = new Uint8Array(32).fill(3);
      const registration = await authenticator.register({
        challenge,
        rpId,
        origin,
        counter: 0,
      });
      const payload = await verifyRegistration({
        response: registration,
        expectedChallenge: encodeBase64url(challenge),
        origin,
        rpId,
      });
      if (!payload) throw new Error('registration failed');
      mesh.userStore.insertKey({
        id: crypto.randomUUID(),
        userId: mesh.boot.userId,
        credentialId: decodeBase64url(payload.credential_id),
        publicKey: payload.public_key,
        rpId: payload.rp_id,
        origin: payload.origin,
        counter: payload.counter,
        transports: payload.transports,
        name: 'synth',
        logSeq: 1,
        now: Date.now(),
      });

      const sess = generateEd25519KeyPair();
      const now = Date.now();
      const delegation = buildPasskeyDelegation({
        uid: mesh.boot.userId,
        sessPk: sess.publicKey,
        now,
        credentialId: payload.credential_id,
      });
      const ch = await call(mesh.runtime, 'http://localhost/api/auth/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ uid: mesh.boot.userId }),
      });
      const chBody = (await ch.json()) as { challenge_id: string; nonce: string };
      const login = buildLogin({
        challengeId: chBody.challenge_id,
        nonce: decodeBase64url(chBody.nonce),
        target: NODE_ID,
        targetPk: NODE_PK,
        uid: mesh.boot.userId,
        entry: 'self',
      });
      const assertion = await authenticator.assert({
        challenge: sha256(encodeDelegation(delegation)),
        rpId,
        origin,
        counter: 1,
      });
      const res = await call(mesh.runtime, 'http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({
          login: encodeBase64url(encodeLogin(login)),
          sig: encodeBase64url(signLogin(sess.secretKey, login)),
          delegation: encodeBase64url(encodeDelegation(delegation)),
          delegation_sig: encodeBase64url(encodePasskeyAssertionSig(assertion)),
        }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { sid?: string }).sid).toBeUndefined();
      expect(sidFromLogin(res).length).toBeGreaterThan(10);

      const jsonSig = await call(mesh.runtime, 'http://localhost/api/auth/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ uid: mesh.boot.userId }),
      });
      const jsonCh = (await jsonSig.json()) as { challenge_id: string; nonce: string };
      const login2 = buildLogin({
        challengeId: jsonCh.challenge_id,
        nonce: decodeBase64url(jsonCh.nonce),
        target: NODE_ID,
        targetPk: NODE_PK,
        uid: mesh.boot.userId,
        entry: 'self',
      });
      const assertion2 = await authenticator.assert({
        challenge: sha256(encodeDelegation(delegation)),
        rpId,
        origin,
        counter: 2,
      });
      const jsonRes = await call(mesh.runtime, 'http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({
          login: encodeBase64url(encodeLogin(login2)),
          sig: encodeBase64url(signLogin(sess.secretKey, login2)),
          delegation: encodeBase64url(encodeDelegation(delegation)),
          delegation_sig: encodeBase64url(new TextEncoder().encode(JSON.stringify(assertion2))),
        }),
      });
      expect(jsonRes.status).toBe(401);
      expect((await jsonRes.json()).code).toBe('DELEGATION_BAD_SIGNATURE');
    } finally {
      mesh.close();
    }
  });

  test('passkey cannot authenticate a different user', async () => {
    const mesh = await bootMesh();
    try {
      const bob = await mesh.keyLogService.bootstrapUser({ username: 'bob', password: PASSWORD });
      const authenticator = await createEs256Authenticator();
      const origin = 'http://localhost:19663';
      const rpId = 'localhost';
      const challenge = new Uint8Array(32).fill(9);
      const registration = await authenticator.register({
        challenge,
        rpId,
        origin,
        counter: 0,
      });
      const payload = await verifyRegistration({
        response: registration,
        expectedChallenge: encodeBase64url(challenge),
        origin,
        rpId,
      });
      if (!payload) throw new Error('registration failed');
      mesh.userStore.insertKey({
        id: crypto.randomUUID(),
        userId: bob.userId,
        credentialId: decodeBase64url(payload.credential_id),
        publicKey: payload.public_key,
        rpId: payload.rp_id,
        origin: payload.origin,
        counter: payload.counter,
        transports: payload.transports,
        name: 'bob-key',
        logSeq: 1,
        now: Date.now(),
      });
      const sess = generateEd25519KeyPair();
      const delegation = buildPasskeyDelegation({
        uid: mesh.boot.userId,
        sessPk: sess.publicKey,
        now: Date.now(),
        credentialId: payload.credential_id,
      });
      const ch = await call(mesh.runtime, 'http://localhost/api/auth/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ uid: mesh.boot.userId }),
      });
      const chBody = (await ch.json()) as { challenge_id: string; nonce: string };
      const login = buildLogin({
        challengeId: chBody.challenge_id,
        nonce: decodeBase64url(chBody.nonce),
        target: NODE_ID,
        targetPk: NODE_PK,
        uid: mesh.boot.userId,
        entry: 'self',
      });
      const assertion = await authenticator.assert({
        challenge: sha256(encodeDelegation(delegation)),
        rpId,
        origin,
        counter: 1,
      });
      const res = await call(mesh.runtime, 'http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({
          login: encodeBase64url(encodeLogin(login)),
          sig: encodeBase64url(signLogin(sess.secretKey, login)),
          delegation: encodeBase64url(encodeDelegation(delegation)),
          delegation_sig: encodeBase64url(encodePasskeyAssertionSig(assertion)),
        }),
      });
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe('DELEGATION_BAD_SIGNATURE');
    } finally {
      mesh.close();
    }
  });

  test('passkey login/options allowCredentials is exact-origin only; empty → 404', async () => {
    const mesh = await bootMesh();
    try {
      const originA = 'http://localhost:19663';
      const originB = 'https://other.example:8443';
      const credA = insertPasskeyRow(mesh.userStore, mesh.boot.userId, {
        origin: originA,
        rpId: 'localhost',
        fill: 11,
      });
      const credB = insertPasskeyRow(mesh.userStore, mesh.boot.userId, {
        origin: originB,
        rpId: 'other.example',
        fill: 12,
      });
      const idA = encodeBase64url(credA);
      const idB = encodeBase64url(credB);

      const fromA = await requestPasskeyLoginOptions(mesh, originA);
      expect(fromA.status).toBe(200);
      const bodyA = (await fromA.json()) as {
        rpId: string;
        allowCredentials: Array<{ id: string }>;
        userVerification: string;
      };
      expect(bodyA.rpId).toBe('localhost');
      expect(bodyA.userVerification).toBe('required');
      expect(bodyA.allowCredentials.map((c) => c.id)).toEqual([idA]);
      expect(bodyA.allowCredentials.map((c) => c.id)).not.toContain(idB);

      const fromB = await requestPasskeyLoginOptions(mesh, originB);
      expect(fromB.status).toBe(200);
      const bodyB = (await fromB.json()) as {
        rpId: string;
        allowCredentials: Array<{ id: string }>;
      };
      expect(bodyB.rpId).toBe('other.example');
      expect(bodyB.allowCredentials.map((c) => c.id)).toEqual([idB]);

      const fromC = await requestPasskeyLoginOptions(mesh, 'https://unrelated.example');
      expect(fromC.status).toBe(404);
      expect((await fromC.json()).code).toBe('NO_PASSKEY_FOR_ORIGIN');
    } finally {
      mesh.close();
    }
  });

  test('passkey login/options trusted origin follows TMEX_TRUST_PROXY rules', async () => {
    const mesh = await bootMesh();
    try {
      const forwardedOrigin = 'https://app.example.com';
      const forwardedCred = insertPasskeyRow(mesh.userStore, mesh.boot.userId, {
        origin: forwardedOrigin,
        rpId: 'app.example.com',
        fill: 21,
      });
      const localCred = insertPasskeyRow(mesh.userStore, mesh.boot.userId, {
        origin: 'http://127.0.0.1:19663',
        rpId: '127.0.0.1',
        fill: 22,
      });
      const forwardedHeaders = {
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'app.example.com',
      };
      const forwardedId = encodeBase64url(forwardedCred);
      const localId = encodeBase64url(localCred);

      const trusted = await requestPasskeyLoginOptions(mesh, null, {
        headers: forwardedHeaders,
        trustProxy: true,
        via: 'self',
      });
      expect(trusted.status).toBe(200);
      const trustedBody = (await trusted.json()) as {
        rpId: string;
        allowCredentials: Array<{ id: string }>;
      };
      expect(trustedBody.rpId).toBe('app.example.com');
      expect(trustedBody.allowCredentials.map((c) => c.id)).toEqual([forwardedId]);

      const untrusted = await requestPasskeyLoginOptions(mesh, null, {
        headers: forwardedHeaders,
        via: 'self',
      });
      expect(untrusted.status).toBe(200);
      const untrustedBody = (await untrusted.json()) as {
        rpId: string;
        allowCredentials: Array<{ id: string }>;
      };
      expect(untrustedBody.rpId).toBe('127.0.0.1');
      expect(untrustedBody.allowCredentials.map((c) => c.id)).toEqual([localId]);

      const viaPeer = await requestPasskeyLoginOptions(mesh, null, {
        headers: forwardedHeaders,
        trustProxy: true,
        via: 'entry-node',
      });
      expect(viaPeer.status).toBe(200);
      const viaPeerBody = (await viaPeer.json()) as {
        rpId: string;
        allowCredentials: Array<{ id: string }>;
      };
      expect(viaPeerBody.rpId).toBe('127.0.0.1');
      expect(viaPeerBody.allowCredentials.map((c) => c.id)).toEqual([localId]);
    } finally {
      mesh.close();
    }
  });

  test('GET /api/auth/passkeys marks usableHere by exact origin match', async () => {
    const mesh = await bootMesh();
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const originHere = 'http://localhost:19663';
      insertPasskeyRow(mesh.userStore, mesh.boot.userId, {
        origin: originHere,
        rpId: 'localhost',
        fill: 31,
        name: 'here',
      });
      insertPasskeyRow(mesh.userStore, mesh.boot.userId, {
        origin: 'https://other.example:8443',
        rpId: 'other.example',
        fill: 32,
        name: 'elsewhere',
      });
      const keys = await call(mesh.runtime, 'http://localhost/api/auth/passkeys', {
        headers: { cookie: `tmex_s_self=${sid}`, origin: originHere },
      });
      expect(keys.status).toBe(200);
      const body = (await keys.json()) as {
        passkeys: Array<{
          name: string | null;
          origin: string;
          rp_id: string;
          usableHere: boolean;
        }>;
      };
      expect(body.passkeys).toHaveLength(2);
      const here = body.passkeys.find((k) => k.name === 'here');
      const elsewhere = body.passkeys.find((k) => k.name === 'elsewhere');
      expect(here?.origin).toBe(originHere);
      expect(here?.rp_id).toBe('localhost');
      expect(here?.usableHere).toBe(true);
      expect(elsewhere?.origin).toBe('https://other.example:8443');
      expect(elsewhere?.rp_id).toBe('other.example');
      expect(elsewhere?.usableHere).toBe(false);
    } finally {
      mesh.close();
    }
  });

  test('passkey register/options uses trusted origin for rpId; verify stores that origin', async () => {
    const mesh = await bootMesh();
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const trustedOrigin = 'https://node.example:8443';
      const opts = await call(mesh.runtime, 'http://localhost/api/auth/passkey/register/options', {
        method: 'POST',
        headers: {
          cookie: `tmex_s_self=${sid}`,
          origin: trustedOrigin,
        },
      });
      expect(opts.status).toBe(200);
      const options = (await opts.json()) as {
        challenge: string;
        challenge_id: string;
        rp: { id: string };
      };
      expect(options.rp.id).toBe('node.example');

      const authenticator = await createEs256Authenticator();
      const registration = await authenticator.register({
        challenge: decodeBase64url(options.challenge),
        rpId: 'node.example',
        origin: trustedOrigin,
        counter: 0,
      });
      const verified = await call(
        mesh.runtime,
        'http://localhost/api/auth/passkey/register/verify',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: `tmex_s_self=${sid}`,
            origin: 'http://localhost:19663',
          },
          body: JSON.stringify({
            challenge_id: options.challenge_id,
            response: registration,
          }),
        }
      );
      expect(verified.status).toBe(200);
      const payload = (await verified.json()) as { origin: string; rp_id: string };
      expect(payload.origin).toBe(trustedOrigin);
      expect(payload.rp_id).toBe('node.example');

      const proxied = await call(
        mesh.runtime,
        'http://localhost/api/auth/passkey/register/options',
        {
          method: 'POST',
          headers: {
            cookie: `tmex_s_self=${sid}`,
            'x-forwarded-proto': 'https',
            'x-forwarded-host': 'app.example.com',
          },
          trustProxy: true,
          via: 'self',
        }
      );
      expect(proxied.status).toBe(200);
      expect(((await proxied.json()) as { rp: { id: string } }).rp.id).toBe('app.example.com');
    } finally {
      mesh.close();
    }
  });
});

async function createEs256Authenticator() {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const x = decodeBase64url(jwk.x ?? '');
  const y = decodeBase64url(jwk.y ?? '');
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const coseKey = encodeCoseEs256(x, y);

  return {
    credentialId,
    async register(input: {
      challenge: Uint8Array;
      rpId: string;
      origin: string;
      counter: number;
    }): Promise<RegistrationResponseJSON> {
      const authData = makeAuthData({
        rpId: input.rpId,
        flags: 0x45,
        counter: input.counter,
        attested: {
          aaguid: new Uint8Array(16),
          credentialId,
          coseKey,
        },
      });
      const clientData = makeClientData('webauthn.create', input.challenge, input.origin);
      const attestationObject = cborMap([
        ['fmt', 'none'],
        ['attStmt', EMPTY_MAP],
        ['authData', authData],
      ]);
      const id = encodeBase64url(credentialId);
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: encodeBase64url(clientData),
          attestationObject: encodeBase64url(attestationObject),
          transports: ['internal'],
        },
        clientExtensionResults: {},
      };
    },
    async assert(input: {
      challenge: Uint8Array;
      rpId: string;
      origin: string;
      counter: number;
    }): Promise<AuthenticationResponseJSON> {
      const authData = makeAuthData({
        rpId: input.rpId,
        flags: 0x05,
        counter: input.counter,
      });
      const clientData = makeClientData('webauthn.get', input.challenge, input.origin);
      const signed = concatBytes(authData, sha256(clientData));
      const raw = new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          keyPair.privateKey,
          signed.slice()
        )
      );
      const id = encodeBase64url(credentialId);
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: encodeBase64url(clientData),
          authenticatorData: encodeBase64url(authData),
          signature: encodeBase64url(ieeeP1363ToDer(raw)),
        },
        clientExtensionResults: {},
      };
    },
  };
}

const EMPTY_MAP = Symbol('empty-map');

function encodeCoseEs256(x: Uint8Array, y: Uint8Array): Uint8Array {
  return cborMap([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, x],
    [-3, y],
  ]);
}

function makeClientData(type: string, challenge: Uint8Array, origin: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type,
      challenge: encodeBase64url(challenge),
      origin,
      crossOrigin: false,
    })
  );
}

function makeAuthData(opts: {
  rpId: string;
  flags: number;
  counter: number;
  attested?: { aaguid: Uint8Array; credentialId: Uint8Array; coseKey: Uint8Array };
}): Uint8Array {
  const rpIdHash = sha256(new TextEncoder().encode(opts.rpId));
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, opts.counter >>> 0, false);
  const parts: Uint8Array[] = [rpIdHash, Uint8Array.of(opts.flags), count];
  if (opts.attested) {
    const idLen = new Uint8Array(2);
    new DataView(idLen.buffer).setUint16(0, opts.attested.credentialId.length, false);
    parts.push(opts.attested.aaguid, idLen, opts.attested.credentialId, opts.attested.coseKey);
  }
  return concatBytes(...parts);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function cborHead(major: number, n: number): Uint8Array {
  if (n < 24) {
    return Uint8Array.of((major << 5) | n);
  }
  if (n < 256) {
    return Uint8Array.of((major << 5) | 24, n);
  }
  if (n < 65536) {
    return Uint8Array.of((major << 5) | 25, (n >> 8) & 0xff, n & 0xff);
  }
  throw new Error('cbor length too large');
}

function cborInt(n: number): Uint8Array {
  if (n >= 0) {
    return cborHead(0, n);
  }
  return cborHead(1, -1 - n);
}

function cborBytes(bytes: Uint8Array): Uint8Array {
  return concatBytes(cborHead(2, bytes.length), bytes);
}

function cborText(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  return concatBytes(cborHead(3, encoded.length), encoded);
}

function cborValue(value: unknown): Uint8Array {
  if (value === EMPTY_MAP) {
    return cborHead(5, 0);
  }
  if (value instanceof Uint8Array) {
    return cborBytes(value);
  }
  if (typeof value === 'string') {
    return cborText(value);
  }
  if (typeof value === 'number') {
    return cborInt(value);
  }
  throw new Error('unsupported cbor value');
}

function cborMap(entries: Array<[number | string, unknown]>): Uint8Array {
  const parts: Uint8Array[] = [cborHead(5, entries.length)];
  for (const [key, value] of entries) {
    parts.push(typeof key === 'string' ? cborText(key) : cborInt(key));
    parts.push(cborValue(value));
  }
  return concatBytes(...parts);
}

function ieeeP1363ToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  const r = derInt(raw.subarray(0, half));
  const s = derInt(raw.subarray(half));
  const body = concatBytes(Uint8Array.of(0x02, r.length), r, Uint8Array.of(0x02, s.length), s);
  return concatBytes(Uint8Array.of(0x30, body.length), body);
}

function derInt(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) {
    start += 1;
  }
  const stripped = bytes.subarray(start);
  if ((stripped[0] ?? 0) & 0x80) {
    return concatBytes(Uint8Array.of(0), stripped);
  }
  return stripped;
}
