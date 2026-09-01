import {
  buildLogin,
  createDelegation,
  createEnrollment,
  createNodeCertificate,
  decodeBase64url,
  encodeAdmitNodePayload,
  encodeBase64url,
  encodeLogin,
  generateEd25519KeyPair,
  signLogin,
} from '@tmex/shared/auth';
import { WebSocketLink } from '@tmex/shared/link';
import { HUB_NOT_WRITER } from '@tmex/shared/uplink';
import {
  KeyLogStore,
  MeshHubStore,
  NodeIdentityStore,
  NodeSessionStore,
  UserKeyService,
  UserStore,
  ensureNodeIdentity,
  makeVerifyPasskeyAssertion,
  nodeSessionCookieName,
} from '../../auth';
import { createMigratedAuthDb } from '../../auth/test-db';
import type { AuthDb } from '../../auth/types';
import { HubRuntime, createHubKeyLogSource, patchNode } from '../../hub';
import type { GatewayRuntime } from '../../runtime';
import type { WebSocketServer } from '../../ws';
import { MESH_VIA_SELF, setMeshRequestContext } from '../mesh-deps';
import { type MeshRuntime, createMeshRuntime } from '../mesh-runtime';
import { fakeSocketPair } from '../test-support';
import type { MeshScheduler } from '../types';
import type { UplinkWsFactory } from '../uplink-client';
import { sameHubUrl } from '../uplink-pool';
import { type UplinkNodeList, decodeUplinkCtl, encodeUplinkCtl } from '../uplink-protocol';

export const PASSWORD = 'tmex-test';
export const HUB_A_URL = 'http://hub-a.test';
export const HUB_B_URL = 'http://hub-b.test';
export const HUB_E_URL = 'http://hub-e.test';
export const FAKE_NODE_ID = 'ef'.repeat(16);
export const dummyServer = { upgrade: () => false };

export type BootUser = {
  userId: string;
  rootKey: Parameters<typeof createDelegation>[0];
  rootPublicKey: Uint8Array;
  rootEpoch: number;
};

export type LiveUplink = {
  publicUrl: string;
  hubLink: WebSocketLink;
  close: () => void;
};

export class FastScheduler implements MeshScheduler {
  now(): number {
    return Date.now();
  }

  async sleep(_ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
    }
    await Promise.resolve();
  }

  interval(fn: () => void, ms: number): { clear: () => void } {
    const id = setInterval(fn, ms);
    return {
      clear() {
        clearInterval(id);
      },
    };
  }
}

export class HubRouter {
  readonly hubs = new Map<string, HubRuntime>();
  readonly down = new Set<string>();
  readonly live: LiveUplink[] = [];
  readonly cookies = new Map<string, string>();
  statusFrames = 0;

  register(publicUrl: string, hub: HubRuntime): void {
    this.hubs.set(normalizePublicUrl(publicUrl), hub);
  }

  takeDown(publicUrl: string): void {
    const key = normalizePublicUrl(publicUrl);
    this.down.add(key);
    for (const row of [...this.live]) {
      if (sameHubUrl(row.publicUrl, publicUrl)) row.close();
    }
  }

  bringUp(publicUrl: string): void {
    this.down.delete(normalizePublicUrl(publicUrl));
  }

  sendCtl(publicUrl: string, msg: Parameters<typeof encodeUplinkCtl>[0]): number {
    const bytes = encodeUplinkCtl(msg);
    let n = 0;
    for (const row of this.live) {
      if (!sameHubUrl(row.publicUrl, publicUrl)) continue;
      try {
        row.hubLink.ctl.send(bytes);
        n += 1;
      } catch {
        /* closed */
      }
    }
    return n;
  }

  factory: UplinkWsFactory = async (url) => {
    const publicUrl = wsUrlToPublic(url);
    if (this.down.has(normalizePublicUrl(publicUrl))) {
      throw new Error(`hub-down:${publicUrl}`);
    }
    const hub = this.hubs.get(normalizePublicUrl(publicUrl));
    if (!hub) throw new Error(`no-hub:${publicUrl}`);
    const [nodeSock, hubSock] = fakeSocketPair();
    const hubLink = new WebSocketLink(hubSock, { role: 'acceptor' });
    hubLink.ctl.onMessage((bytes) => {
      try {
        const decoded = decodeUplinkCtl(bytes);
        if (decoded.t === 'node.status') this.statusFrames += 1;
      } catch {
        /* ignore non-ctl */
      }
    });
    hub.attachLocalNode(hubLink);
    const live: LiveUplink = {
      publicUrl,
      hubLink,
      close: () => {
        const idx = this.live.indexOf(live);
        if (idx >= 0) this.live.splice(idx, 1);
        try {
          hubLink.close('hub-down');
        } catch {
          /* ignore */
        }
        try {
          nodeSock.close(1000, 'hub-down');
        } catch {
          /* ignore */
        }
      },
    };
    this.live.push(live);
    return nodeSock;
  };

  fetch: import('../../hub/hub-peer-poller').HubPeerFetch = async (url, init) => {
    const parsed = new URL(url);
    const publicUrl = normalizePublicUrl(`${parsed.protocol}//${parsed.host}`);
    if (this.down.has(publicUrl)) throw new Error(`hub-down:${publicUrl}`);
    const hub = this.hubs.get(publicUrl);
    if (!hub) throw new Error(`no-hub:${publicUrl}`);
    const headers = new Headers(init?.headers);
    const cookie = this.cookies.get(publicUrl);
    if (cookie) headers.set('cookie', cookie);
    return callHub(hub, url, { ...init, headers });
  };
}

export type HarnessNode = {
  mesh: MeshRuntime;
  db: AuthDb;
  close: () => void;
  userStore: UserStore;
  unsubscribe?: () => void;
  roleEnv?: Record<string, string>;
  roleRestarts?: number[];
};

export function memoryHubRoleHooks(initial?: Record<string, string>): {
  env: Record<string, string>;
  restarts: number[];
  patchHubRoleEnv: (patch: Record<string, string>) => Promise<void>;
  scheduleHubRoleRestart: (delayMs: number) => void;
} {
  const env = {
    TMEX_HUB_MODE: 'active',
    TMEX_HUB_WRITER_EPOCH: '1',
    ...initial,
  };
  const restarts: number[] = [];
  return {
    env,
    restarts,
    patchHubRoleEnv: async (patch) => {
      Object.assign(env, patch);
    },
    scheduleHubRoleRestart: (delayMs) => {
      restarts.push(delayMs);
    },
  };
}

export type MultiHubTopology = {
  router: HubRouter;
  boot: BootUser;
  aKeys: UserKeyService;
  aKeyLog: KeyLogStore;
  a: HarnessNode;
  b: HarnessNode;
  c: HarnessNode;
  d: HarnessNode;
  stop: () => Promise<void>;
};

export function fakeGateway(db: AuthDb, label: string): GatewayRuntime {
  return {
    port: 0,
    db,
    wsServer: {} as WebSocketServer,
    handleRequest: () => undefined,
    dispatchHttp: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/api/system/info') {
        return new Response(JSON.stringify({ version: 'test', node: label }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path === '/api/devices') {
        return new Response(JSON.stringify({ devices: [{ id: `dev-${label}` }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'not-found' }), { status: 404 });
    },
    websocket: {
      backpressureLimit: 1024,
      closeOnBackpressureLimit: true,
      open() {},
      message() {},
      drain() {},
      close() {},
      closeSession() {},
    },
    onRestartRequested() {},
    stop: async () => {},
  };
}

export function meshHubsOf(db: AuthDb): MeshHubStore {
  return new MeshHubStore(db);
}

export function keyLogList(db: AuthDb, userId: string) {
  return new KeyLogStore(db).list(userId);
}

export function sidFromResponse(res: Response, nodeId = MESH_VIA_SELF): string {
  const cookies = res.headers.getSetCookie?.() ?? [];
  const prefix = `${nodeSessionCookieName(nodeId)}=`;
  for (const cookie of cookies) {
    if (cookie.startsWith(prefix)) {
      return cookie.slice(prefix.length).split(';')[0] ?? '';
    }
  }
  const header = res.headers.get('set-cookie') ?? '';
  const match = header.match(new RegExp(`${nodeSessionCookieName(nodeId)}=([^;]*)`));
  if (match?.[1]) return match[1];
  throw new Error(`no session cookie for ${nodeId}: ${header}`);
}

export async function callMesh(
  mesh: MeshRuntime,
  url: string,
  init?: RequestInit & { cookie?: string }
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (init?.cookie) headers.set('cookie', init.cookie);
  const req = new Request(url, { ...init, headers });
  setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp: '127.0.0.1' });
  const res = await mesh.handleRequest(req, dummyServer);
  if (!(res instanceof Response)) {
    throw new Error(`unhandled ${url}`);
  }
  return res;
}

export async function loginSelf(mesh: MeshRuntime, boot: BootUser): Promise<string> {
  const sess = generateEd25519KeyPair();
  const now = Date.now();
  const del = createDelegation(boot.rootKey, {
    uid: boot.userId,
    sessPk: sess.publicKey,
    now,
  });
  const ch = await callMesh(mesh, 'http://entry/api/auth/challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uid: boot.userId }),
  });
  if (ch.status !== 200) {
    throw new Error(`challenge ${ch.status}: ${await ch.text()}`);
  }
  const body = (await ch.json()) as { challenge_id: string; nonce: string; nodePk: string };
  const login = buildLogin({
    challengeId: body.challenge_id,
    nonce: decodeBase64url(body.nonce),
    target: mesh.nodeId,
    targetPk: decodeBase64url(body.nodePk),
    uid: boot.userId,
    entry: MESH_VIA_SELF,
  });
  const res = await callMesh(mesh, 'http://entry/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      login: encodeBase64url(encodeLogin(login)),
      sig: encodeBase64url(signLogin(sess.secretKey, login)),
      delegation: encodeBase64url(del.bytes),
      delegation_sig: encodeBase64url(del.sig),
    }),
  });
  if (res.status !== 200) {
    throw new Error(`login ${res.status}: ${await res.text()}`);
  }
  return sidFromResponse(res, MESH_VIA_SELF);
}

export async function loginRemote(
  entry: MeshRuntime,
  target: MeshRuntime,
  boot: BootUser,
  cookie: string
): Promise<Response> {
  const sess = generateEd25519KeyPair();
  const now = Date.now();
  const del = createDelegation(boot.rootKey, {
    uid: boot.userId,
    sessPk: sess.publicKey,
    now,
  });
  const ch = await callMesh(entry, `http://entry/n/${target.nodeId}/api/auth/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cookie,
    body: JSON.stringify({ uid: boot.userId }),
  });
  if (ch.status !== 200) return ch;
  const body = (await ch.json()) as { challenge_id: string; nonce: string; nodePk: string };
  const login = buildLogin({
    challengeId: body.challenge_id,
    nonce: decodeBase64url(body.nonce),
    target: target.nodeId,
    targetPk: decodeBase64url(body.nodePk),
    uid: boot.userId,
    entry: entry.nodeId,
  });
  return callMesh(entry, `http://entry/n/${target.nodeId}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cookie,
    body: JSON.stringify({
      login: encodeBase64url(encodeLogin(login)),
      sig: encodeBase64url(signLogin(sess.secretKey, login)),
      delegation: encodeBase64url(del.bytes),
      delegation_sig: encodeBase64url(del.sig),
    }),
  });
}

export function selfCookie(sid: string): string {
  return `${nodeSessionCookieName(MESH_VIA_SELF)}=${sid}`;
}

export function jarFor(selfSid: string, nodeId: string, nodeSid: string): string {
  return `${selfCookie(selfSid)}; ${nodeSessionCookieName(nodeId)}=${nodeSid}`;
}

export function wireReplication(mesh: MeshRuntime): () => void {
  const hub = mesh.hub;
  if (!hub) return () => {};
  return mesh.onNodeList((list, meta) => {
    hub.applyReplicatedNodeList(list, { hubNodeId: meta.hubNodeId });
  });
}

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 8_000,
  stepMs = 10
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

export async function waitOnline(mesh: MeshRuntime, timeoutMs = 8_000): Promise<void> {
  await waitUntil(() => mesh.uplink.state === 'online' && mesh.lastNodeList !== null, timeoutMs);
}

export function notWriterBody(writerHubId: string, writerPublicUrl: string, writerEpoch: number) {
  return {
    code: HUB_NOT_WRITER,
    writerHubId,
    writerPublicUrl,
    writerEpoch,
  };
}

export async function callHub(
  hub: HubRuntime,
  url: string,
  init?: RequestInit & { cookie?: string }
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (init?.cookie) headers.set('cookie', init.cookie);
  const req = new Request(url, { ...init, headers });
  setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp: '127.0.0.1' });
  const res = await hub.handleRequest(req, dummyServer);
  if (!(res instanceof Response)) {
    throw new Error(`unhandled hub ${url}`);
  }
  return res;
}

type EnrollOpts = {
  name: string;
  version: string;
  roles: { hub: boolean; node: boolean };
  hubUrl: string | null;
  hubUrls?: string[];
  hubPublicUrl?: string | null;
  hubMode?: 'active' | 'standby';
  hubPriority?: number;
  hubWriterEpoch?: number;
  hubPeers?: string[];
  hubAutoPromote?: boolean;
  hubAutoPromoteTimeoutMs?: number;
  uplinkHub?: HubRuntime | null;
  wsFactory?: UplinkWsFactory;
  scheduler?: MeshScheduler;
  label: string;
  pending?: PendingHarnessNode;
  patchHubRoleEnv?: (patch: Record<string, string>) => Promise<void>;
  scheduleHubRoleRestart?: (delayMs: number) => void;
  roleEnv?: Record<string, string>;
  hubFetch?: import('../../hub/hub-peer-poller').HubPeerFetch;
};

export type PendingHarnessNode = {
  db: AuthDb;
  close: () => void;
  identity: Awaited<ReturnType<typeof ensureNodeIdentity>>;
};

export async function createPendingNode(): Promise<PendingHarnessNode> {
  const { db, close } = createMigratedAuthDb();
  const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
  return { db, close, identity };
}

export async function bootHubA(
  router: HubRouter,
  extra?: {
    hubPeers?: string[];
    patchHubRoleEnv?: (patch: Record<string, string>) => Promise<void>;
    scheduleHubRoleRestart?: (delayMs: number) => void;
    roleEnv?: Record<string, string>;
    hubFetch?: import('../../hub/hub-peer-poller').HubPeerFetch;
    hubAutoPromote?: boolean;
    hubAutoPromoteTimeoutMs?: number;
  }
): Promise<{
  node: HarnessNode;
  boot: BootUser;
  keys: UserKeyService;
  keyLog: KeyLogStore;
}> {
  const { db, close } = createMigratedAuthDb();
  const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
  const userStore = new UserStore(db);
  const keyLog = new KeyLogStore(db);
  const nodeSessionStore = new NodeSessionStore(db);
  const keys = new UserKeyService({
    db,
    userStore,
    keyLogStore: keyLog,
    nodeSessionStore,
    verifyPasskeyAssertion: makeVerifyPasskeyAssertion(userStore),
  });
  const boot = await keys.bootstrapUserWithSelfAdmit({
    username: 'alice',
    password: PASSWORD,
    identity,
  });
  const role = memoryHubRoleHooks({
    TMEX_HUB_MODE: 'active',
    TMEX_HUB_WRITER_EPOCH: '1',
    ...extra?.roleEnv,
  });
  const mesh = await createMeshRuntime({
    db,
    gateway: fakeGateway(db, 'a'),
    userId: boot.userId,
    config: {
      roles: { hub: true, node: true },
      hubUrl: null,
      hubPublicUrl: HUB_A_URL,
      hubMode: 'active',
      hubPriority: 100,
      hubWriterEpoch: 1,
      hubPeers: extra?.hubPeers,
      hubAutoPromote: extra?.hubAutoPromote,
      hubAutoPromoteTimeoutMs: extra?.hubAutoPromoteTimeoutMs,
      peerPort: 0,
      stunServers: [],
    },
    startPeerServer: false,
    pingIntervalMs: 15_000,
    networkInterfaces: () => ({}),
    loadNative: async () => null,
    scheduler: new FastScheduler(),
    patchHubRoleEnv: extra?.patchHubRoleEnv ?? role.patchHubRoleEnv,
    scheduleHubRoleRestart: extra?.scheduleHubRoleRestart ?? role.scheduleHubRoleRestart,
    hubFetch: extra?.hubFetch ?? router.fetch,
  });
  const unsubscribe = wireReplication(mesh);
  if (!mesh.hub) throw new Error('hub A missing HubRuntime');
  router.register(HUB_A_URL, mesh.hub);
  await mesh.start();
  await waitOnline(mesh);
  const aSid = await loginSelf(mesh, boot);
  router.cookies.set(HUB_A_URL, selfCookie(aSid));
  return {
    node: {
      mesh,
      db,
      close,
      userStore,
      unsubscribe,
      roleEnv: role.env,
      roleRestarts: role.restarts,
    },
    boot,
    keys,
    keyLog,
  };
}

export async function enrollAndStart(
  parent: {
    mesh: MeshRuntime;
    boot: BootUser;
    keys: UserKeyService;
    keyLog: KeyLogStore;
  },
  opts: EnrollOpts
): Promise<HarnessNode> {
  const pending = opts.pending ?? (await createPendingNode());
  const { db, close, identity } = pending;
  const now = Date.now();
  const enrollment = await createEnrollment(parent.boot.rootKey, {
    uid: parent.boot.userId,
    rootEpoch: parent.boot.rootEpoch,
    now,
    ttlMs: 60_000,
  });
  const sid = await loginSelf(parent.mesh, parent.boot);
  const cookie = selfCookie(sid);
  const hub = parent.mesh.hub;
  if (!hub) throw new Error('parent has no hub');
  const created = await callHub(hub, 'http://hub/api/hub/enrollments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cookie,
    body: JSON.stringify({
      enroll_pk: encodeBase64url(enrollment.enrollPk),
      authorization: encodeBase64url(enrollment.authorizationBytes),
      authorization_sig: encodeBase64url(enrollment.authorizationSig),
      exp: now + 60_000,
    }),
  });
  if (created.status !== 201) {
    throw new Error(`enroll create ${created.status}: ${await created.text()}`);
  }
  const cert = createNodeCertificate(enrollment.enrollSk, {
    uid: parent.boot.userId,
    edPk: identity.edPublicKey,
    x25519Pk: identity.x25519PublicKey,
    enrollPk: enrollment.enrollPk,
    now,
    nodeId: identity.nodeId,
  });
  const redeemed = await callHub(hub, 'http://hub/api/hub/enrollments/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      certificate: encodeBase64url(cert.certificateBytes),
      cert_sig: encodeBase64url(cert.certSig),
      name: opts.name,
      version: opts.version,
    }),
  });
  if (redeemed.status !== 200) {
    throw new Error(`redeem ${redeemed.status}: ${await redeemed.text()}`);
  }
  const admitPayload = encodeAdmitNodePayload({
    authorization_bytes: enrollment.authorizationBytes,
    authorization_sig: enrollment.authorizationSig,
    certificate_bytes: cert.certificateBytes,
    cert_sig: cert.certSig,
  });
  const admitted = await parent.keys.signAndApply(parent.boot.userId, parent.boot.rootKey, {
    type: 'admit-node',
    payload: admitPayload,
  });
  if (!admitted.ok) throw new Error(`admit failed: ${JSON.stringify(admitted)}`);

  const rows = parent.keyLog.list(parent.boot.userId);
  const head = parent.keyLog.head(parent.boot.userId);
  if (!head) throw new Error('missing key log head');
  const userStore = new UserStore(db);
  const keyLog = new KeyLogStore(db);
  const sessions = new NodeSessionStore(db);
  const keys = new UserKeyService({
    db,
    userStore,
    keyLogStore: keyLog,
    nodeSessionStore: sessions,
    verifyPasskeyAssertion: makeVerifyPasskeyAssertion(userStore),
  });
  const joined = await keys.verifyChainForJoin(
    rows.map((row) => ({ bytes: row.bytes, sig: row.sig })),
    parent.boot.rootPublicKey,
    head.hash
  );
  if (!joined.ok) throw new Error(`join chain failed: ${joined.error}`);

  const meshHubStore = new MeshHubStore(db);
  if (opts.roles.hub && opts.hubUrl) {
    meshHubStore.upsert(
      {
        hubNodeId: parent.mesh.nodeId,
        publicUrl: opts.hubUrl,
        name: 'hub-a',
        mode: 'active',
        priority: 0,
        writerEpoch: 1,
        caFingerprint: null,
        online: true,
        lastSeenAt: now,
      },
      now
    );
  }

  const role = opts.roles.hub
    ? memoryHubRoleHooks({
        TMEX_HUB_MODE: opts.hubMode ?? 'standby',
        TMEX_HUB_WRITER_EPOCH: String(opts.hubWriterEpoch ?? 1),
        ...opts.roleEnv,
      })
    : null;
  const mesh = await createMeshRuntime({
    db,
    gateway: fakeGateway(db, opts.label),
    userId: parent.boot.userId,
    config: {
      roles: opts.roles,
      hubUrl: opts.hubUrl,
      hubUrls: opts.hubUrls,
      hubPublicUrl: opts.hubPublicUrl,
      hubMode: opts.hubMode,
      hubPriority: opts.hubPriority,
      hubWriterEpoch: opts.hubWriterEpoch,
      hubPeers: opts.hubPeers,
      hubAutoPromote: opts.hubAutoPromote,
      hubAutoPromoteTimeoutMs: opts.hubAutoPromoteTimeoutMs,
      peerPort: 0,
      stunServers: [],
    },
    uplinkHub: opts.uplinkHub,
    wsFactory: opts.wsFactory,
    meshHubStore,
    startPeerServer: false,
    pingIntervalMs: 15_000,
    networkInterfaces: () => ({}),
    loadNative: async () => null,
    scheduler: opts.scheduler ?? new FastScheduler(),
    patchHubRoleEnv: opts.patchHubRoleEnv ?? role?.patchHubRoleEnv,
    scheduleHubRoleRestart: opts.scheduleHubRoleRestart ?? role?.scheduleHubRoleRestart,
    hubFetch: opts.hubFetch,
  });
  const unsubscribe = opts.roles.hub ? wireReplication(mesh) : undefined;
  await mesh.start();
  await waitOnline(mesh);
  if (opts.hubUrl && opts.wsFactory) {
    const attached = mesh.attachedHub()?.publicUrl ?? null;
    if (!attached || !sameHubUrl(attached, opts.hubUrl)) {
      await mesh.uplink.switchTo(opts.hubUrl);
      await waitOnline(mesh);
    }
  }
  return {
    mesh,
    db,
    close,
    userStore,
    unsubscribe,
    roleEnv: role?.env,
    roleRestarts: role?.restarts,
  };
}

export async function bootAbcdTopology(): Promise<MultiHubTopology> {
  const router = new HubRouter();
  const bPending = await createPendingNode();
  const aBoot = await bootHubA(router, { hubPeers: [bPending.identity.nodeIdHex] });
  const parent = {
    mesh: aBoot.node.mesh,
    boot: aBoot.boot,
    keys: aBoot.keys,
    keyLog: aBoot.keyLog,
  };
  const b = await enrollAndStart(parent, {
    name: 'node-b',
    version: 'ver-b',
    roles: { hub: true, node: true },
    hubUrl: HUB_A_URL,
    hubPublicUrl: HUB_B_URL,
    hubMode: 'standby',
    hubPriority: 200,
    hubWriterEpoch: 1,
    hubPeers: [aBoot.node.mesh.nodeId],
    wsFactory: router.factory,
    pending: bPending,
    label: 'b',
    hubFetch: router.fetch,
  });
  if (!b.mesh.hub) throw new Error('hub B missing HubRuntime');
  router.register(HUB_B_URL, b.mesh.hub);
  await waitUntil(() => meshHubsOf(aBoot.node.db).get(b.mesh.nodeId)?.mode === 'standby', 8_000);

  const c = await enrollAndStart(parent, {
    name: 'node-c',
    version: 'ver-c',
    roles: { hub: false, node: true },
    hubUrl: HUB_A_URL,
    uplinkHub: null,
    wsFactory: router.factory,
    label: 'c',
  });
  const d = await enrollAndStart(parent, {
    name: 'node-d',
    version: 'ver-d',
    roles: { hub: false, node: true },
    hubUrl: HUB_A_URL,
    hubUrls: [HUB_B_URL],
    uplinkHub: null,
    wsFactory: router.factory,
    label: 'd',
  });

  await waitUntil(() => {
    const cHubs = meshHubsOf(c.db).list();
    const dHubs = meshHubsOf(d.db).list();
    return (
      Boolean(
        cHubs.find((row) => row.hubNodeId === aBoot.node.mesh.nodeId && row.mode === 'active')
      ) &&
      Boolean(cHubs.find((row) => row.hubNodeId === b.mesh.nodeId && row.mode === 'standby')) &&
      Boolean(
        dHubs.find((row) => row.hubNodeId === aBoot.node.mesh.nodeId && row.mode === 'active')
      ) &&
      Boolean(dHubs.find((row) => row.hubNodeId === b.mesh.nodeId && row.mode === 'standby'))
    );
  }, 8_000);

  await waitUntil(
    () =>
      b.userStore.getCert(c.mesh.nodeId) != null &&
      b.userStore.getCert(d.mesh.nodeId) != null &&
      b.userStore.getCert(aBoot.node.mesh.nodeId) != null,
    8_000
  );
  aBoot.node.mesh.hub?.uplink.broadcastAllNodeLists();
  await waitUntil(
    () =>
      b.userStore.getNode(aBoot.node.mesh.nodeId) != null &&
      b.userStore.getNode(c.mesh.nodeId) != null &&
      b.userStore.getNode(d.mesh.nodeId) != null,
    8_000
  );

  const nodes = [aBoot.node, b, c, d];
  return {
    router,
    boot: aBoot.boot,
    aKeys: aBoot.keys,
    aKeyLog: aBoot.keyLog,
    a: aBoot.node,
    b,
    c,
    d,
    stop: async () => {
      for (const node of [...nodes].reverse()) {
        node.unsubscribe?.();
        try {
          await node.mesh.stop();
        } catch {
          /* ignore */
        }
        try {
          await node.mesh.hub?.stop();
        } catch {
          /* ignore */
        }
        node.close();
      }
    },
  };
}

export function attachedUrl(mesh: MeshRuntime): string | null {
  return mesh.attachedHub()?.publicUrl ?? null;
}

export function attachedHubId(mesh: MeshRuntime): string | null {
  return mesh.attachedHub()?.hubNodeId ?? null;
}

export function stampNodeVersions(db: AuthDb, version: string, except?: ReadonlySet<string>): void {
  const store = new UserStore(db);
  for (const node of store.listNodes()) {
    if (node.status === 'revoked') continue;
    if (except?.has(node.id)) continue;
    patchNode(db, node.id, { version });
  }
}

export function reconstructHubRuntime(
  node: HarnessNode,
  opts: {
    userId: string;
    keys: UserKeyService;
    keyLog: KeyLogStore;
    authorizedHubIds: string[];
    mode?: 'active' | 'standby';
    writerEpoch?: number;
    publicUrl?: string;
    priority?: number;
    fetchPeerStatus?: import('../../hub/hub-peer-poller').HubPeerFetch;
  }
): HubRuntime {
  return new HubRuntime({
    db: node.db,
    userStore: node.userStore,
    keyLogSource: createHubKeyLogSource(opts.keys, opts.keyLog),
    meshHubs: node.mesh.hub?.meshHubs ?? meshHubsOf(node.db),
    config: {
      publicUrl: opts.publicUrl ?? HUB_A_URL,
      stun: [],
      nodeId: node.mesh.nodeId,
      hubNodeId: node.mesh.nodeId,
      mode: opts.mode ?? 'active',
      priority: opts.priority ?? 100,
      writerEpoch: opts.writerEpoch ?? 1,
      authorizedHubIds: opts.authorizedHubIds,
    },
    authenticate: () => ({
      userId: opts.userId,
      entryNodeId: node.mesh.nodeId,
      sid: 'reconstructed',
    }),
    fetchPeerStatus: opts.fetchPeerStatus,
  });
}

export async function getMeshHubs(mesh: MeshRuntime, cookie: string) {
  const res = await callMesh(mesh, 'http://entry/api/mesh/hubs', { cookie });
  if (res.status !== 200) {
    throw new Error(`GET /api/mesh/hubs ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as {
    hubs: Array<{
      nodeId: string;
      publicUrl: string;
      mode: string;
      writerEpoch: number;
      online?: boolean;
      authorization?: 'signed' | 'env' | 'self';
    }>;
    attached: {
      hubNodeId: string | null;
      publicUrl: string;
      mode: string | null;
      writerEpoch: number | null;
    } | null;
    writerHubId: string | null;
    candidates: string[];
  };
}

export async function getMeshNodes(mesh: MeshRuntime, cookie: string) {
  const res = await callMesh(mesh, 'http://entry/api/mesh/nodes', { cookie });
  if (res.status !== 200) {
    throw new Error(`GET /api/mesh/nodes ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as {
    nodes: Array<{
      id: string;
      isHub?: boolean;
      hubMode?: string;
      name?: string;
      attachedHubId?: string;
      online?: boolean;
    }>;
  };
}

export function stampHubCtlVersions(topo: {
  a: HarnessNode;
  b: HarnessNode;
}): void {
  const now = Date.now();
  topo.a.mesh.hub?.registry.updateMeta(topo.b.mesh.nodeId, { version: '1.1.13' }, now);
  topo.b.mesh.hub?.registry.updateMeta(topo.a.mesh.nodeId, { version: '1.1.13' }, now);
  stampNodeVersions(topo.a.db, '1.1.13');
  stampNodeVersions(topo.b.db, '1.1.13');
}

export async function attachSplitAbcd(topo: MultiHubTopology): Promise<void> {
  stampHubCtlVersions(topo);
  await topo.d.mesh.uplink.switchTo(HUB_B_URL);
  await waitUntil(
    () => attachedUrl(topo.c.mesh) === HUB_A_URL && attachedUrl(topo.d.mesh) === HUB_B_URL,
    8_000
  );
  stampHubCtlVersions(topo);
  topo.a.mesh.hub?.uplink.publishLocalAttachments();
  topo.b.mesh.hub?.onWriterUplinkOnline();
  await waitUntil(() => {
    stampHubCtlVersions(topo);
    const dOnB = topo.b.mesh.hub?.registry.get(topo.d.mesh.nodeId)?.authenticated === true;
    const cOnA = topo.a.mesh.hub?.registry.get(topo.c.mesh.nodeId)?.authenticated === true;
    const dRoute = topo.a.mesh.hub?.uplink.attachments.attachedHubId(topo.d.mesh.nodeId);
    const cRoute = topo.b.mesh.hub?.uplink.attachments.attachedHubId(topo.c.mesh.nodeId);
    return dOnB && cOnA && dRoute === topo.b.mesh.nodeId && cRoute === topo.a.mesh.nodeId;
  }, 8_000);
}

export function craftNodeList(
  base: UplinkNodeList | null,
  over: Partial<UplinkNodeList>
): UplinkNodeList {
  return {
    t: 'node.list',
    version: (base?.version ?? 1) + 1,
    key_log_head: base?.key_log_head ?? { seq: 0n, hash: new Uint8Array(32) },
    rtc: base?.rtc ?? { stun: [], turn: null },
    nodes: base?.nodes ?? [],
    ...over,
  };
}

function normalizePublicUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    if (url.protocol === 'wss:') url.protocol = 'https:';
    url.pathname = url.pathname.replace(/\/+$/, '');
    if (url.pathname === '/hub/uplink') url.pathname = '';
    url.search = '';
    url.hash = '';
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return raw.replace(/\/+$/, '');
  }
}

function wsUrlToPublic(raw: string): string {
  return normalizePublicUrl(raw);
}
