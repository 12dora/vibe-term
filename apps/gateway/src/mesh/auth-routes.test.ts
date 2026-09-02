import { describe, expect, test } from 'bun:test';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import {
  DELEGATION_TTL_MS,
  KEYLOG_TYPE_UNSUPPORTED_BY_NODES,
  MIN_ROTATE_ROOT_KEEP_RECORD_VERSION,
  buildLogin,
  buildPasskeyDelegation,
  createDelegation,
  decodeBase64url,
  encodeBase64url,
  encodeClearTotpPayload,
  encodeDelegation,
  encodeLogin,
  encodeRotateRootKeepPayload,
  encodeSetTotpPayload,
  encryptTotpSecret,
  generateEd25519KeyPair,
  generateKdfParams,
  rootKeyFromSeed,
  sha256,
  signLogin,
  totpCode,
} from '@tmex/shared/auth';
import type { LinkSession } from '@tmex/shared/link';
import type { HubMode } from '@tmex/shared/uplink';
import { ChallengeStore } from '../auth/challenge-store';
import { KeyLogStore } from '../auth/key-log-store';
import { MeshHubStore } from '../auth/mesh-hub-store';
import { NodeSessionStore } from '../auth/node-session-store';
import { encodePasskeyAssertionSig, verifyRegistration } from '../auth/passkey';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserKeyService } from '../auth/user-key-service';
import { UserStore } from '../auth/user-store';
import { MemoryLocalAuthStore } from '../db/local-auth-settings';
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
  readonly reach = new Map<string, 'lan' | 'wan' | 'relay' | null>();
  readonly transport = new Map<string, 'ws-secure' | 'relay' | 'dc' | null>();
  readonly rtt = new Map<string, number | null>();
  readonly listeners = new Set<(e: import('./mesh-deps').NodeEventPayload) => void>();
  failGetLink = 0;

  async getLink(nodeId: string): Promise<LinkSession> {
    if (this.failGetLink > 0) {
      this.failGetLink -= 1;
      throw new NodeUnreachableError(nodeId);
    }
    const link = this.links.get(nodeId);
    if (!link) throw new NodeUnreachableError(nodeId);
    return link;
  }

  listReach(): Map<string, 'lan' | 'wan' | 'relay' | null> {
    return this.reach;
  }

  transportOf(nodeId: string): 'ws-secure' | 'relay' | 'dc' | null {
    return this.transport.get(nodeId) ?? null;
  }

  rttOf(nodeId: string): number | null {
    return this.rtt.get(nodeId) ?? null;
  }

  hubOnline = new Set<string>();

  listHubOnline(): Set<string> {
    return this.hubOnline;
  }

  onNodeEvent(cb: (e: import('./mesh-deps').NodeEventPayload) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emit(event: import('./mesh-deps').NodeEventPayload): void {
    for (const cb of this.listeners) cb(event);
  }
}

// biome-ignore lint/suspicious/noExportsInTest: shared harness
export class FakeWs implements OpenedWsStream {
  readonly sent: Uint8Array[] = [];
  private msg: Array<(b: Uint8Array) => void> = [];
  private closed: Array<(info: { code?: number; reason?: string }) => void> = [];
  closedOnce = false;

  sendError: Error | null = null;

  send(bytes: Uint8Array): Promise<void> {
    if (this.closedOnce) return Promise.resolve();
    if (this.sendError) return Promise.reject(this.sendError);
    this.sent.push(bytes);
    return Promise.resolve();
  }
  onMessage(cb: (bytes: Uint8Array) => void): void {
    this.msg.push(cb);
  }
  onClose(cb: (info: { code?: number; reason?: string }) => void): void {
    this.closed.push(cb);
  }
  close(code?: number, reason?: string): void {
    if (this.closedOnce) return;
    this.closedOnce = true;
    for (const cb of this.closed) cb({ code, reason });
  }
  pushFromRemote(bytes: Uint8Array): void {
    if (this.closedOnce) return;
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
  httpOpenError: Error | null = null;
  lastWs: FakeWs | null = null;
  wsAuth: string | null = null;
  wsCid: string | undefined;
  readonly wsOpens: Array<{ link: LinkSession; auth: string; cid?: string; ws: FakeWs }> = [];
  wsOpenError: Error | null = null;

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
    if (this.httpOpenError) {
      const err = this.httpOpenError;
      this.httpOpenError = null;
      throw err;
    }
    this.lastOpen = {
      path: open.path,
      headers: open.headers,
      auth: open.auth,
      method: open.method,
    };
    return this.nextResponse;
  }

  async openWsStream(link: LinkSession, auth: string, cid?: string): Promise<OpenedWsStream> {
    if (this.wsOpenError) {
      const err = this.wsOpenError;
      this.wsOpenError = null;
      throw err;
    }
    this.wsAuth = auth;
    this.wsCid = cid;
    this.lastWs = new FakeWs();
    this.wsOpens.push({ link, auth, cid, ws: this.lastWs });
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
  selfStatus?: () => import('./types').UplinkStatus;
  listedNames?: () => ReadonlyArray<{ id: string; name: string }>;
  selfName?: () => string | null;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  streamLog?: (line: string) => void;
  skipUserBootstrap?: boolean;
  attachedHub?: () => import('./uplink-pool').AttachedHub | null;
  hubMode?: () => HubMode | null;
}) {
  const { db, close } = createMigratedAuthDb();
  const userStore = new UserStore(db);
  const keyLogStore = new KeyLogStore(db);
  const nodeSessionStore = new NodeSessionStore(db);
  const keyLogService = new UserKeyService({ db, userStore, keyLogStore, nodeSessionStore });
  const boot = options?.skipUserBootstrap
    ? ({
        userId: '',
        rootPublicKey: new Uint8Array(32),
        rootEpoch: 0,
        rootKey: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
      } as unknown as Awaited<ReturnType<UserKeyService['bootstrapUser']>>)
    : await keyLogService.bootstrapUser({ username: 'alice', password: PASSWORD });
  const challengeStore = new ChallengeStore({ now: options?.now });
  const peers = options?.peers ?? new FakePeers();
  const streams = options?.streams ?? new FakeStreams();
  const hubStore = new MeshHubStore(db);
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
    primaryUserId: boot.userId || undefined,
    hubStore,
    attachedHub: options?.attachedHub,
    hubMode: options?.hubMode,
    selfStatus: options?.selfStatus,
    listedNames: options?.listedNames,
    selfName: options?.selfName,
    sleep: options?.sleep,
    streamLog: options?.streamLog,
  });
  return {
    close,
    runtime,
    userStore,
    hubStore,
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
      const body = (await res.json()) as { mode: string; localAuth?: { supported: boolean } };
      expect(body.mode).toBe('none');
      expect(body.localAuth?.supported).toBe(true);
    } finally {
      standalone.close();
    }
  });

  test('GET /api/auth/mode standalone+effective 返回 mesh 载荷与 localAuth', async () => {
    const mesh = await bootMesh({ roles: { hub: false, node: false } });
    try {
      const store = new MemoryLocalAuthStore();
      store.setEnabled(true);
      mesh.runtime.auth.setLocalAuthStore(store);
      const res = await call(mesh.runtime, 'http://localhost/api/auth/mode', {
        headers: { origin: 'http://localhost:19663' },
      });
      const body = (await res.json()) as {
        mode: string;
        nodeId: string;
        uid: string;
        username: string;
        localAuth: {
          supported: boolean;
          enabled: boolean;
          effective: boolean;
          credentialsPresent: boolean;
        };
      };
      expect(body.mode).toBe('mesh');
      expect(body.nodeId).toBe(NODE_ID);
      expect(body.username).toBe('alice');
      expect(body.uid).toBe(mesh.boot.userId);
      expect(body.localAuth).toEqual({
        supported: true,
        enabled: true,
        effective: true,
        credentialsPresent: true,
      });
    } finally {
      mesh.close();
    }
  });

  test('GET /api/auth/mode node 角色 localAuth.supported=false', async () => {
    const mesh = await bootMesh();
    try {
      const res = await call(mesh.runtime, 'http://localhost/api/auth/mode');
      const body = (await res.json()) as {
        mode: string;
        localAuth: { supported: boolean; effective: boolean };
      };
      expect(body.mode).toBe('mesh');
      expect(body.localAuth.supported).toBe(false);
      expect(body.localAuth.effective).toBe(false);
    } finally {
      mesh.close();
    }
  });

  test('POST /api/auth/local 无凭证拒绝开启；bootstrap 后可开；公网拒绝', async () => {
    const mesh = await bootMesh({
      roles: { hub: false, node: false },
      skipUserBootstrap: true,
    });
    try {
      const store = new MemoryLocalAuthStore();
      mesh.runtime.auth.setLocalAuthStore(store);
      const enable = await call(mesh.runtime, 'http://localhost/api/auth/local', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
        clientIp: '127.0.0.1',
      });
      expect(enable.status).toBe(409);
      expect((await enable.json()).code).toBe('CREDENTIALS_REQUIRED');

      const remoteBoot = await call(mesh.runtime, 'http://localhost/api/auth/local/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: 'tmex-test' }),
        clientIp: '8.8.8.8',
      });
      expect(remoteBoot.status).toBe(403);
      expect((await remoteBoot.json()).code).toBe('LOCAL_ONLY');

      const boot = await call(mesh.runtime, 'http://localhost/api/auth/local/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: 'tmex-test' }),
        clientIp: '127.0.0.1',
      });
      expect(boot.status).toBe(200);
      const bootBody = (await boot.json()) as {
        localAuth: {
          supported: boolean;
          credentialsPresent: boolean;
          effective: boolean;
          enabled: boolean;
        };
      };
      expect(bootBody.localAuth).toEqual({
        supported: true,
        enabled: false,
        effective: false,
        credentialsPresent: true,
      });

      const remoteEnable = await call(mesh.runtime, 'http://localhost/api/auth/local', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
        clientIp: '8.8.8.8',
      });
      expect(remoteEnable.status).toBe(403);

      const ok = await call(mesh.runtime, 'http://localhost/api/auth/local', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
        clientIp: '127.0.0.1',
      });
      expect(ok.status).toBe(200);
      const enabled = (await ok.json()) as {
        localAuth: { effective: boolean; enabled: boolean };
      };
      expect(enabled.localAuth.enabled).toBe(true);
      expect(enabled.localAuth.effective).toBe(true);

      const again = await call(mesh.runtime, 'http://localhost/api/auth/local/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'eve', password: 'tmex-test' }),
        clientIp: '127.0.0.1',
      });
      expect(again.status).toBe(409);
      expect((await again.json()).code).toBe('LOCAL_AUTH_ENABLED');

      const mode = await call(mesh.runtime, 'http://localhost/api/auth/mode');
      const modeBody = (await mode.json()) as { mode: string; uid: string };
      expect(modeBody.mode).toBe('mesh');
      expect(modeBody.uid).toBeTruthy();
      const { sid } = await challengeAndLogin(mesh.runtime, {
        userId: modeBody.uid,
        rootKey: (
          await mesh.keyLogService.bootstrapUser({ username: 'owner', password: 'tmex-test' })
        ).rootKey,
      });
      expect(sid).toBeTruthy();
      const disable = await call(mesh.runtime, 'http://localhost/api/auth/local', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `tmex_s_self=${sid}`,
        },
        body: JSON.stringify({ enabled: false }),
        clientIp: '8.8.8.8',
      });
      expect(disable.status).toBe(200);
      expect(
        ((await disable.json()) as { localAuth: { effective: boolean } }).localAuth.effective
      ).toBe(false);
    } finally {
      mesh.close();
    }
  });

  test('POST /api/auth/local node 角色 404', async () => {
    const mesh = await bootMesh();
    try {
      const res = await call(mesh.runtime, 'http://localhost/api/auth/local', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
        clientIp: '127.0.0.1',
      });
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe('not_standalone');
    } finally {
      mesh.close();
    }
  });

  test('isAuthPublicPath：登录流始终公开；local 仅 standalone 未生效时公开', async () => {
    const { isAuthPublicPath } = await import('./auth-routes');
    const login = [
      '/api/auth/mode',
      '/api/auth/nodes',
      '/api/auth/challenge',
      '/api/auth/login',
      '/api/auth/passkey/login/options',
    ];
    for (const path of login) {
      expect(isAuthPublicPath(path, { standalone: false, localAuthEffective: false })).toBe(true);
      expect(isAuthPublicPath(path, { standalone: true, localAuthEffective: true })).toBe(true);
    }
    expect(
      isAuthPublicPath('/api/auth/local', { standalone: true, localAuthEffective: false })
    ).toBe(true);
    expect(
      isAuthPublicPath('/api/auth/local/bootstrap', {
        standalone: true,
        localAuthEffective: false,
      })
    ).toBe(true);
    expect(
      isAuthPublicPath('/api/auth/local', { standalone: true, localAuthEffective: true })
    ).toBe(false);
    expect(
      isAuthPublicPath('/api/auth/local', { standalone: false, localAuthEffective: false })
    ).toBe(false);
    expect(
      isAuthPublicPath('/api/auth/logout', { standalone: true, localAuthEffective: false })
    ).toBe(false);
  });

  test('GET /api/auth/mode uses the writer hub from mesh_hubs', async () => {
    const mesh = await bootMesh();
    try {
      mesh.hubStore.replaceAll(
        [
          {
            hubNodeId: 'bb'.repeat(16),
            publicUrl: 'https://standby.example',
            name: null,
            mode: 'standby',
            priority: 10,
            writerEpoch: 9,
            caFingerprint: null,
            online: true,
            lastSeenAt: null,
          },
          {
            hubNodeId: 'cc'.repeat(16),
            publicUrl: 'https://writer.example',
            name: null,
            mode: 'active',
            priority: 20,
            writerEpoch: 5,
            caFingerprint: null,
            online: true,
            lastSeenAt: null,
          },
        ],
        1
      );
      mesh.userStore.upsertHubAuthorization({
        userId: mesh.boot.userId,
        hubNodeId: 'cc'.repeat(16),
        status: 'active',
        admitSeq: 1,
        updatedSeq: 1,
      });
      const res = await call(mesh.runtime, 'http://localhost/api/auth/mode');
      const body = (await res.json()) as { hubNodeId: string; hubPublicUrl: string };
      expect(body.hubNodeId).toBe('cc'.repeat(16));
      expect(body.hubPublicUrl).toBe('https://writer.example');
    } finally {
      mesh.close();
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
      expect((body as { caFingerprint?: string | null }).caFingerprint).toBeNull();
      runtime.stop();
    } finally {
      hub.close();
    }
  });

  test('GET /api/auth/mode exposes caFingerprint from tlsInfo', async () => {
    const mesh = await bootMesh();
    try {
      const fingerprint = 'ef'.repeat(32);
      mesh.runtime.auth.setTlsInfo(() => ({
        caFingerprint: fingerprint,
        caPem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
      }));
      const res = await call(mesh.runtime, 'http://localhost/api/auth/mode');
      const body = (await res.json()) as { caFingerprint: string | null };
      expect(body.caFingerprint).toBe(fingerprint);
    } finally {
      mesh.close();
    }
  });

  test('GET /api/auth/mode reuses TLS derivation within TTL', async () => {
    const mesh = await bootMesh();
    try {
      let tlsCalls = 0;
      const fingerprint = 'ab'.repeat(32);
      mesh.runtime.auth.setTlsInfo(() => {
        tlsCalls += 1;
        return { caFingerprint: fingerprint, caPem: 'pem' };
      });
      const first = await call(mesh.runtime, 'http://localhost/api/auth/mode');
      const second = await call(mesh.runtime, 'http://localhost/api/auth/mode');
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(((await first.json()) as { caFingerprint: string }).caFingerprint).toBe(fingerprint);
      expect(((await second.json()) as { caFingerprint: string }).caFingerprint).toBe(fingerprint);
      expect(tlsCalls).toBe(1);
    } finally {
      mesh.close();
    }
  });

  test('GET /api/auth/mode cache generation is per AuthRoutes instance', async () => {
    const a = await bootMesh();
    const b = await bootMesh();
    try {
      let aCalls = 0;
      let bCalls = 0;
      a.runtime.auth.setTlsInfo(() => {
        aCalls += 1;
        return { caFingerprint: 'aa'.repeat(32), caPem: 'a' };
      });
      b.runtime.auth.setTlsInfo(() => {
        bCalls += 1;
        return { caFingerprint: 'bb'.repeat(32), caPem: 'b' };
      });
      await call(a.runtime, 'http://localhost/api/auth/mode');
      await call(b.runtime, 'http://localhost/api/auth/mode');
      expect(aCalls).toBe(1);
      expect(bCalls).toBe(1);
      a.runtime.auth.invalidateAuthModeCache();
      await call(a.runtime, 'http://localhost/api/auth/mode');
      await call(b.runtime, 'http://localhost/api/auth/mode');
      expect(aCalls).toBe(2);
      expect(bCalls).toBe(1);
    } finally {
      a.close();
      b.close();
    }
  });

  test('GET /api/auth/mode invalidates cached derivation after local-auth bootstrap', async () => {
    const mesh = await bootMesh({
      roles: { hub: false, node: false },
      skipUserBootstrap: true,
    });
    try {
      const store = new MemoryLocalAuthStore();
      mesh.runtime.auth.setLocalAuthStore(store);
      let tlsCalls = 0;
      mesh.runtime.auth.setTlsInfo(() => {
        tlsCalls += 1;
        return { caFingerprint: null, caPem: null };
      });
      const before = await call(mesh.runtime, 'http://localhost/api/auth/mode');
      const beforeAgain = await call(mesh.runtime, 'http://localhost/api/auth/mode');
      const beforeBody = (await before.json()) as { mode: string; uid: string | null };
      expect(beforeBody.mode).toBe('none');
      expect(beforeBody.uid).toBeNull();
      expect(((await beforeAgain.json()) as { mode: string }).mode).toBe('none');
      expect(tlsCalls).toBe(1);

      const boot = await call(mesh.runtime, 'http://localhost/api/auth/local/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: 'tmex-test' }),
        clientIp: '127.0.0.1',
      });
      expect(boot.status).toBe(200);
      const enable = await call(mesh.runtime, 'http://localhost/api/auth/local', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
        clientIp: '127.0.0.1',
      });
      expect(enable.status).toBe(200);

      const after = await call(mesh.runtime, 'http://localhost/api/auth/mode');
      const afterBody = (await after.json()) as {
        mode: string;
        uid: string | null;
        username: string;
      };
      expect(afterBody.mode).toBe('mesh');
      expect(afterBody.username).toBe('owner');
      expect(afterBody.uid).toBeTruthy();
      expect(tlsCalls).toBe(2);
    } finally {
      mesh.close();
    }
  });

  test('GET /api/auth/mode keeps per-origin passkey fields off the shared cache', async () => {
    const mesh = await bootMesh();
    try {
      let tlsCalls = 0;
      mesh.runtime.auth.setTlsInfo(() => {
        tlsCalls += 1;
        return { caFingerprint: 'cd'.repeat(32), caPem: 'pem' };
      });
      insertPasskeyRow(mesh.userStore, mesh.boot.userId, {
        origin: 'http://localhost:19663',
        rpId: 'localhost',
        fill: 3,
      });
      const local = await call(mesh.runtime, 'http://localhost/api/auth/mode', {
        headers: { origin: 'http://localhost:19663' },
      });
      const remote = await call(mesh.runtime, 'http://192.168.1.8/api/auth/mode', {
        headers: { origin: 'http://192.168.1.8' },
      });
      const localBody = (await local.json()) as {
        passkeysForThisOrigin: boolean;
        passkeyAvailable: boolean;
      };
      const remoteBody = (await remote.json()) as {
        passkeysForThisOrigin: boolean;
        passkeyAvailable: boolean;
      };
      expect(localBody.passkeysForThisOrigin).toBe(true);
      expect(localBody.passkeyAvailable).toBe(true);
      expect(remoteBody.passkeysForThisOrigin).toBe(false);
      expect(remoteBody.passkeyAvailable).toBe(false);
      expect(tlsCalls).toBe(1);
    } finally {
      mesh.close();
    }
  });

  test('GET /api/auth/mode derivation expires after TTL using injectable now', async () => {
    let now = 1_000;
    const mesh = await bootMesh({ now: () => now });
    try {
      let tlsCalls = 0;
      mesh.runtime.auth.setTlsInfo(() => {
        tlsCalls += 1;
        return { caFingerprint: 'ef'.repeat(32), caPem: 'pem' };
      });
      await call(mesh.runtime, 'http://localhost/api/auth/mode');
      now += 4_999;
      await call(mesh.runtime, 'http://localhost/api/auth/mode');
      expect(tlsCalls).toBe(1);
      now += 2;
      await call(mesh.runtime, 'http://localhost/api/auth/mode');
      expect(tlsCalls).toBe(2);
    } finally {
      mesh.close();
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

      // 浏览器把本机入口写成真实 nodeId（/api/auth/mode.nodeId），必须与 challenge 的 'self' 哨兵等价
      const realEntry = await challengeAndLogin(mesh.runtime, mesh.boot, {
        entry: NODE_ID,
      });
      expect(realEntry.res.status).toBe(200);

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

  test('GET /api/auth/totp-record requires session and 404s when TOTP is off', async () => {
    const mesh = await bootMesh({ roles: { hub: true, node: true } });
    try {
      const denied = await call(mesh.runtime, 'http://localhost/api/auth/totp-record');
      expect(denied.status).toBe(401);
      expect(denied.headers.get('Cache-Control')).toBe('private, no-store');
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const missing = await call(mesh.runtime, 'http://localhost/api/auth/totp-record', {
        headers: { cookie: `tmex_s_self=${sid}` },
      });
      expect(missing.status).toBe(404);
      expect(missing.headers.get('Cache-Control')).toBe('private, no-store');
      expect((await missing.json()).code).toBe('TOTP_NOT_ENABLED');
    } finally {
      mesh.close();
    }
  });

  test('rotate-root-keep keeps the session cookie and totp-record returns the nested payload', async () => {
    const mesh = await bootMesh({ roles: { hub: true, node: true } });
    try {
      const {
        deriveSeed,
        deriveTotpKey,
        buildKeyLogRecord,
        encodeKeyLogRecord,
        signKeyLogRecordWithRoot,
      } = await import('@tmex/shared/auth');
      const { kdfParamsFromJson } = await import('../auth/user-key-service');
      const user = mesh.userStore.getById(mesh.boot.userId);
      if (!user) throw new Error('missing user');
      const oldParams = kdfParamsFromJson(user.kdfParamsJson);
      const oldSeed = await deriveSeed(PASSWORD, oldParams);
      const secret = new Uint8Array(20).fill(7);
      const before = mesh.keyLogService.currentState(mesh.boot.userId);
      const oldKTotp = deriveTotpKey(oldSeed, mesh.boot.userId, before.rootEpoch);
      const totpPayload = await encryptTotpSecret(oldKTotp, secret, {
        uid: mesh.boot.userId,
        root_epoch: before.rootEpoch,
        seq: before.head.seq + 1n,
      });
      expect(
        (
          await mesh.keyLogService.signAndApply(mesh.boot.userId, mesh.boot.rootKey, {
            type: 'set-totp',
            payload: encodeSetTotpPayload(totpPayload),
          })
        ).ok
      ).toBe(true);

      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot, {
        totp: {
          code: totpCode(secret, Math.floor(Date.now() / 1000)),
          k_totp: encodeBase64url(oldKTotp),
        },
      });
      const cookie = { headers: { cookie: `tmex_s_self=${sid}` } };
      const head = await call(mesh.runtime, 'http://localhost/api/auth/totp-record', cookie);
      expect(head.status).toBe(200);
      expect(head.headers.get('Cache-Control')).toBe('private, no-store');
      const first = (await head.json()) as {
        record_seq: number | string;
        root_epoch: number;
        payload: string;
      };
      expect(first.root_epoch).toBe(before.rootEpoch);
      expect(decodeBase64url(first.payload).length).toBeGreaterThan(0);

      const newParams = generateKdfParams();
      const newRoot = rootKeyFromSeed(new Uint8Array(32).fill(9));
      const state = mesh.keyLogService.currentState(mesh.boot.userId);
      const newKTotp = deriveTotpKey(
        new Uint8Array(32).fill(3),
        mesh.boot.userId,
        state.rootEpoch + 1
      );
      const wrapped = await encryptTotpSecret(newKTotp, secret, {
        uid: mesh.boot.userId,
        root_epoch: state.rootEpoch + 1,
        seq: state.head.seq + 1n,
      });
      const rec = buildKeyLogRecord(state.head, state.rootEpoch, {
        uid: mesh.boot.userId,
        type: 'rotate-root-keep',
        payload: encodeRotateRootKeepPayload({
          root_public_key: newRoot.publicKey,
          kdf_params: newParams,
          totp: {
            root_epoch: state.rootEpoch + 1,
            seq: state.head.seq + 1n,
            payload: wrapped,
          },
        }),
        signer: 'root',
        credential_id: null,
      });
      const bytes = encodeKeyLogRecord(rec);
      const sig = signKeyLogRecordWithRoot(mesh.boot.rootKey, bytes);
      const appended = await call(mesh.runtime, 'http://localhost/api/auth/keylog', {
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
      expect(appended.status).toBe(200);

      const still = await call(mesh.runtime, 'http://localhost/api/auth/keylog/head', cookie);
      expect(still.status).toBe(200);
      const totpRec = await call(mesh.runtime, 'http://localhost/api/auth/totp-record', cookie);
      expect(totpRec.status).toBe(200);
      const body = (await totpRec.json()) as {
        record_seq: number | string;
        root_epoch: number;
        payload: string;
      };
      expect(body.root_epoch).toBe(state.rootEpoch + 1);
      expect(body.record_seq).toBe(Number(state.head.seq + 1n));
      expect(decodeBase64url(body.payload)).toEqual(encodeSetTotpPayload(wrapped));

      const after = mesh.keyLogService.currentState(mesh.boot.userId);
      const code = totpCode(secret, Math.floor(Date.now() / 1000));
      const login = await challengeAndLogin(
        mesh.runtime,
        { userId: mesh.boot.userId, rootKey: newRoot },
        { totp: { code, k_totp: encodeBase64url(newKTotp) } }
      );
      expect(login.res.status).toBe(200);
      expect(after.totp?.alg).toBe('A256GCM');
    } finally {
      mesh.close();
    }
  });

  test('rotate-root-keep compat gate 409s cert-only nodes; revoked certs do not block', async () => {
    const mesh = await bootMesh({ roles: { hub: true, node: true } });
    try {
      const certOnlyId = 'bb'.repeat(16);
      mesh.userStore.upsertCert({
        nodeId: certOnlyId,
        userId: mesh.boot.userId,
        admitRecordSeq: 1,
        certificateBytes: new Uint8Array(8),
        certSig: new Uint8Array(8),
        authorizationBytes: new Uint8Array(8),
        authorizationSig: new Uint8Array(8),
      });
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const { buildKeyLogRecord, encodeKeyLogRecord, signKeyLogRecordWithRoot } = await import(
        '@tmex/shared/auth'
      );
      const state = mesh.keyLogService.currentState(mesh.boot.userId);
      const rec = buildKeyLogRecord(state.head, state.rootEpoch, {
        uid: mesh.boot.userId,
        type: 'rotate-root-keep',
        payload: encodeRotateRootKeepPayload({
          root_public_key: new Uint8Array(32).fill(4),
          kdf_params: generateKdfParams(),
          totp: null,
        }),
        signer: 'root',
        credential_id: null,
      });
      const bytes = encodeKeyLogRecord(rec);
      const sig = signKeyLogRecordWithRoot(mesh.boot.rootKey, bytes);
      const blocked = await call(mesh.runtime, 'http://localhost/api/auth/keylog', {
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
      expect(blocked.status).toBe(409);
      expect((await blocked.json()).code).toBe(KEYLOG_TYPE_UNSUPPORTED_BY_NODES);
      expect(mesh.keyLogService.currentState(mesh.boot.userId).head.seq).toBe(state.head.seq);

      mesh.userStore.markCertRevoked(certOnlyId, 9);
      mesh.userStore.createNode({
        id: 'cc'.repeat(16),
        userId: mesh.boot.userId,
        name: 'old-revoked-cert',
        version: '1.1.15',
        now: 1,
      });
      mesh.userStore.upsertCert({
        nodeId: 'cc'.repeat(16),
        userId: mesh.boot.userId,
        admitRecordSeq: 1,
        certificateBytes: new Uint8Array(8),
        certSig: new Uint8Array(8),
        authorizationBytes: new Uint8Array(8),
        authorizationSig: new Uint8Array(8),
        revokedLogSeq: 4,
      });
      const allowed = await call(mesh.runtime, 'http://localhost/api/auth/keylog', {
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
      expect(allowed.status).toBe(200);
    } finally {
      mesh.close();
    }
  });

  test('POST /api/auth/keylog rotate-root-keep invalidates unused enrollment tokens', async () => {
    const mesh = await bootMesh({ roles: { hub: true, node: true } });
    try {
      const enrollPk = new Uint8Array(32).fill(41);
      mesh.userStore.createEnrollmentToken({
        id: 'tok-unused',
        userId: mesh.boot.userId,
        enrollPublicKey: enrollPk,
        authorizationJson: '{}',
        authorizationSig: new Uint8Array(8),
        expiresAt: Date.now() + 60_000,
      });
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const { buildKeyLogRecord, encodeKeyLogRecord, signKeyLogRecordWithRoot } = await import(
        '@tmex/shared/auth'
      );
      const state = mesh.keyLogService.currentState(mesh.boot.userId);
      const rec = buildKeyLogRecord(state.head, state.rootEpoch, {
        uid: mesh.boot.userId,
        type: 'rotate-root-keep',
        payload: encodeRotateRootKeepPayload({
          root_public_key: new Uint8Array(32).fill(4),
          kdf_params: generateKdfParams(),
          totp: null,
        }),
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
      expect(res.status).toBe(200);
      const token = mesh.userStore.getEnrollmentTokenByEnrollPublicKey(enrollPk);
      expect(token).not.toBeNull();
      expect(
        mesh.userStore.consumeEnrollmentToken(enrollPk, {
          nodeId: 'bb'.repeat(16),
          now: Date.now() + 1_000,
        })
      ).toBeNull();
    } finally {
      mesh.close();
    }
  });

  test('rotate-root-keep compat gate 409s old nodes even with x-tmex-force-keylog', async () => {
    const mesh = await bootMesh({ roles: { hub: true, node: true } });
    try {
      const { buildKeyLogRecord, encodeKeyLogRecord, signKeyLogRecordWithRoot } = await import(
        '@tmex/shared/auth'
      );
      mesh.userStore.createNode({
        id: 'bb'.repeat(16),
        userId: mesh.boot.userId,
        name: 'old',
        version: '1.1.15',
        now: 1,
      });
      mesh.userStore.upsertCert({
        nodeId: 'bb'.repeat(16),
        userId: mesh.boot.userId,
        admitRecordSeq: 1,
        certificateBytes: new Uint8Array(8),
        certSig: new Uint8Array(8),
        authorizationBytes: new Uint8Array(8),
        authorizationSig: new Uint8Array(8),
      });
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const state = mesh.keyLogService.currentState(mesh.boot.userId);
      const rec = buildKeyLogRecord(state.head, state.rootEpoch, {
        uid: mesh.boot.userId,
        type: 'rotate-root-keep',
        payload: encodeRotateRootKeepPayload({
          root_public_key: new Uint8Array(32).fill(4),
          kdf_params: generateKdfParams(),
          totp: null,
        }),
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
          'x-tmex-force-keylog': '1',
        },
        body: JSON.stringify({
          bytes: encodeBase64url(bytes),
          sig: encodeBase64url(sig),
        }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; minVersion: string };
      expect(body.code).toBe(KEYLOG_TYPE_UNSUPPORTED_BY_NODES);
      expect(body.minVersion).toBe(MIN_ROTATE_ROOT_KEEP_RECORD_VERSION);
      expect(mesh.keyLogService.currentState(mesh.boot.userId).head.seq).toBe(state.head.seq);
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

  test('trustProxy keys login limiter on CF-Connecting-IP; ignored when untrusted', async () => {
    const failLogin = (
      runtime: MeshHttpRuntime,
      opts: { clientIp: string; trustProxy: boolean; cfIp: string }
    ) =>
      call(runtime, 'http://localhost/api/auth/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': opts.cfIp,
        },
        body: JSON.stringify({}),
        clientIp: opts.clientIp,
        trustProxy: opts.trustProxy,
      });

    const mesh = await bootMesh();
    try {
      const socket = '10.0.0.1';
      for (let i = 0; i < 10; i++) {
        const res = await failLogin(mesh.runtime, {
          clientIp: socket,
          trustProxy: true,
          cfIp: '203.0.113.1',
        });
        expect(res.status).toBe(400);
      }
      const other = await failLogin(mesh.runtime, {
        clientIp: socket,
        trustProxy: true,
        cfIp: '203.0.113.2',
      });
      expect(other.status).toBe(400);
      const same = await failLogin(mesh.runtime, {
        clientIp: socket,
        trustProxy: true,
        cfIp: '203.0.113.1',
      });
      expect(same.status).toBe(429);
      expect((await same.json()).code).toBe('RATE_LIMITED');
    } finally {
      mesh.close();
    }

    const untrusted = await bootMesh();
    try {
      const socket = '10.0.0.1';
      for (let i = 0; i < 10; i++) {
        const res = await failLogin(untrusted.runtime, {
          clientIp: socket,
          trustProxy: false,
          cfIp: `203.0.113.${i + 1}`,
        });
        expect(res.status).toBe(400);
      }
      const blocked = await failLogin(untrusted.runtime, {
        clientIp: socket,
        trustProxy: false,
        cfIp: '198.51.100.9',
      });
      expect(blocked.status).toBe(429);
      expect((await blocked.json()).code).toBe('RATE_LIMITED');
    } finally {
      untrusted.close();
    }
  });

  test('bootstrap loopback ignores spoofed XFF unless trustProxy; CF-Connecting-IP is never local', async () => {
    const bootstrap = (
      runtime: MeshHttpRuntime,
      opts: { clientIp: string; trustProxy?: boolean; headers?: Record<string, string> }
    ) =>
      call(runtime, 'http://localhost/api/auth/local/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...opts.headers },
        body: JSON.stringify({ username: 'owner', password: 'tmex-test' }),
        clientIp: opts.clientIp,
        trustProxy: opts.trustProxy,
      });

    const openStandalone = async () => {
      const mesh = await bootMesh({
        roles: { hub: false, node: false },
        skipUserBootstrap: true,
      });
      mesh.runtime.auth.setLocalAuthStore(new MemoryLocalAuthStore());
      return mesh;
    };

    const a = await openStandalone();
    try {
      const res = await bootstrap(a.runtime, { clientIp: '127.0.0.1' });
      expect(res.status).toBe(200);
    } finally {
      a.close();
    }

    for (const trustProxy of [false, true]) {
      const mesh = await openStandalone();
      try {
        const res = await bootstrap(mesh.runtime, {
          clientIp: '127.0.0.1',
          trustProxy,
          headers: { 'cf-connecting-ip': '203.0.113.5' },
        });
        expect(res.status).toBe(403);
        expect((await res.json()).code).toBe('LOCAL_ONLY');
      } finally {
        mesh.close();
      }
    }

    const c = await openStandalone();
    try {
      const res = await bootstrap(c.runtime, {
        clientIp: '127.0.0.1',
        trustProxy: true,
        headers: { 'x-forwarded-for': '203.0.113.5' },
      });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('LOCAL_ONLY');
    } finally {
      c.close();
    }

    const d = await openStandalone();
    try {
      const res = await bootstrap(d.runtime, {
        clientIp: '127.0.0.1',
        trustProxy: false,
        headers: { 'x-forwarded-for': '203.0.113.5' },
      });
      expect(res.status).toBe(200);
    } finally {
      d.close();
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

  test('POST /api/auth/keylog returns 409 HUB_NOT_WRITER before local apply when attached hub is not writer', async () => {
    const writerId = 'bb'.repeat(16);
    const standbyId = 'cc'.repeat(16);
    const mesh = await bootMesh({
      roles: { hub: true, node: true },
      attachedHub: () => ({
        hubNodeId: standbyId,
        publicUrl: 'https://standby.example',
        mode: 'standby',
        writerEpoch: 1,
        since: 1,
      }),
    });
    try {
      mesh.hubStore.replaceAll(
        [
          {
            hubNodeId: writerId,
            publicUrl: 'https://writer.example',
            name: 'writer',
            mode: 'active',
            priority: 10,
            writerEpoch: 4,
            caFingerprint: null,
            online: true,
            lastSeenAt: null,
          },
          {
            hubNodeId: standbyId,
            publicUrl: 'https://standby.example',
            name: 'standby',
            mode: 'standby',
            priority: 20,
            writerEpoch: 1,
            caFingerprint: null,
            online: true,
            lastSeenAt: null,
          },
        ],
        1
      );
      mesh.userStore.upsertHubAuthorization({
        userId: mesh.boot.userId,
        hubNodeId: writerId,
        status: 'active',
        admitSeq: 1,
        updatedSeq: 1,
      });
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const { buildKeyLogRecord, encodeKeyLogRecord, signKeyLogRecordWithRoot } = await import(
        '@tmex/shared/auth'
      );
      const before = mesh.keyLogService.currentState(mesh.boot.userId);
      const rec = buildKeyLogRecord(before.head, before.rootEpoch, {
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
      expect(await res.json()).toEqual({
        code: 'HUB_NOT_WRITER',
        writerHubId: writerId,
        writerPublicUrl: 'https://writer.example',
        writerEpoch: 4,
      });
      expect(mesh.keyLogService.currentState(mesh.boot.userId).head.seq).toBe(before.head.seq);
      expect(mesh.published).toHaveLength(0);
    } finally {
      mesh.close();
    }
  });

  test('POST /api/auth/keylog still applies locally when attached hub is unknown', async () => {
    const mesh = await bootMesh({
      roles: { hub: true, node: true },
      attachedHub: () => null,
    });
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
      expect(res.status).toBe(200);
      expect(mesh.published).toHaveLength(1);
    } finally {
      mesh.close();
    }
  });

  test('dual-role standby refuses local key-log append when attached hub is null', async () => {
    const writerId = 'bb'.repeat(16);
    const mesh = await bootMesh({
      roles: { hub: true, node: true },
      attachedHub: () => null,
      hubMode: () => 'standby',
    });
    try {
      mesh.hubStore.replaceAll(
        [
          {
            hubNodeId: writerId,
            publicUrl: 'https://writer.example',
            name: 'writer',
            mode: 'active',
            priority: 10,
            writerEpoch: 4,
            caFingerprint: null,
            online: true,
            lastSeenAt: null,
          },
        ],
        1
      );
      mesh.userStore.upsertHubAuthorization({
        userId: mesh.boot.userId,
        hubNodeId: writerId,
        status: 'active',
        admitSeq: 1,
        updatedSeq: 1,
      });
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const { buildKeyLogRecord, encodeKeyLogRecord, signKeyLogRecordWithRoot } = await import(
        '@tmex/shared/auth'
      );
      const before = mesh.keyLogService.currentState(mesh.boot.userId);
      const rec = buildKeyLogRecord(before.head, before.rootEpoch, {
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
      expect(await res.json()).toEqual({
        code: 'HUB_NOT_WRITER',
        writerHubId: writerId,
        writerPublicUrl: 'https://writer.example',
        writerEpoch: 4,
      });
      expect(mesh.keyLogService.currentState(mesh.boot.userId).head.seq).toBe(before.head.seq);
      expect(mesh.published).toHaveLength(0);
    } finally {
      mesh.close();
    }
  });

  test('dual-role active writer applies local key-log append when attached hub is null', async () => {
    const mesh = await bootMesh({
      roles: { hub: true, node: true },
      attachedHub: () => null,
      hubMode: () => 'active',
    });
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
      expect(res.status).toBe(200);
      expect(mesh.published).toHaveLength(1);
    } finally {
      mesh.close();
    }
  });

  test('plain node unknown attach does not return HUB_NOT_WRITER', async () => {
    const mesh = await bootMesh({
      roles: { hub: false, node: true },
      attachedHub: () => null,
      hubMode: () => 'standby',
    });
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const { buildKeyLogRecord, encodeKeyLogRecord, signKeyLogRecordWithRoot } = await import(
        '@tmex/shared/auth'
      );
      const before = mesh.keyLogService.currentState(mesh.boot.userId);
      const rec = buildKeyLogRecord(before.head, before.rootEpoch, {
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
      const body = (await res.json()) as { code?: string };
      expect(body.code).not.toBe('HUB_NOT_WRITER');
      expect(mesh.keyLogService.currentState(mesh.boot.userId).head.seq).toBe(before.head.seq);
    } finally {
      mesh.close();
    }
  });

  test('standalone unknown attach is not gated as HUB_NOT_WRITER', async () => {
    const mesh = await bootMesh({
      roles: { hub: false, node: false },
      attachedHub: () => null,
      hubMode: () => 'standby',
    });
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const { buildKeyLogRecord, encodeKeyLogRecord, signKeyLogRecordWithRoot } = await import(
        '@tmex/shared/auth'
      );
      const before = mesh.keyLogService.currentState(mesh.boot.userId);
      const rec = buildKeyLogRecord(before.head, before.rootEpoch, {
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
      const body = (await res.json()) as { code?: string };
      expect(body.code).not.toBe('HUB_NOT_WRITER');
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
