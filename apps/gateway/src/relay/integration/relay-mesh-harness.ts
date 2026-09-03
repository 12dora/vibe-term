import { WebSocketLink } from '@tmex/shared/link';
import {
  KeyLogStore,
  NodeIdentityStore,
  NodeSessionStore,
  UserKeyService,
  UserStore,
  ensureNodeIdentity,
  makeVerifyPasskeyAssertion,
} from '../../auth';
import { MeshRelayStore } from '../../auth/mesh-relay-store';
import { createMigratedAuthDb } from '../../auth/test-db';
import {
  callMesh,
  fakeGateway,
  loginSelf,
  selfCookie,
  waitUntil,
} from '../../mesh/integration/multi-hub-harness';
import { createMeshRuntime } from '../../mesh/mesh-runtime';
import { RelayUplinkClient } from '../../mesh/relay-uplink-client';
import { fakeSocketPair } from '../../mesh/test-support';
import type { UplinkWsFactory } from '../../mesh/uplink-client';
import { type RelayHarness, bootRelayHarness } from '../relay-test-harness';
import {
  NODE_PASSWORD,
  NODE_ROLES,
  type NodeBoot,
  RELAY_TEST_PUBLIC_URL,
  type RelayMeshHarness,
  type RelayMeshNode,
  type RelayTenant,
  ShortBackoffScheduler,
  type TenantOptions,
} from './relay-mesh-types';
import {
  admitNode,
  callRelayEnroll,
  joinNode,
  revokeNode,
  rotateMetaKey,
  submitPrepared,
  submitRecord,
  waitRelayKeyLogSynced,
} from './relay-tenant-ops';

export * from './relay-mesh-types';
export {
  openRelayKeyLogPage,
  redeemAtRelay,
  waitRelayKeyLogSynced,
} from './relay-tenant-ops';
export { waitUntil };

const RELAY_HOST = new URL(RELAY_TEST_PUBLIC_URL).host;

/** 把发往中继公开地址的请求接进进程内 RelayRuntime，其余交还原生 fetch。 */
function installRelayFetch(relay: RelayHarness): () => void {
  const original = globalThis.fetch;
  const patched = ((input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (url.host === RELAY_HOST) return relay.fetch(`${url.pathname}${url.search}`, init);
    return original(input as RequestInfo, init);
  }) as typeof fetch;
  patched.preconnect = original.preconnect?.bind(original) ?? (() => {});
  globalThis.fetch = patched;
  return () => {
    globalThis.fetch = original;
  };
}

export async function bootRelayMeshHarness(
  opts: Parameters<typeof bootRelayHarness>[0] = {}
): Promise<RelayMeshHarness> {
  const relay = await bootRelayHarness({ listDebounceMs: 0, now: () => Date.now(), ...opts });
  const restoreFetch = installRelayFetch(relay);
  const nodes: RelayMeshNode[] = [];
  const wsFactory: UplinkWsFactory = async (url) => {
    if (new URL(url).host !== RELAY_HOST) throw new Error(`no-relay:${url}`);
    const [nodeSock, relaySock] = fakeSocketPair();
    relay.runtime.uplink.accept(new WebSocketLink(relaySock, { role: 'acceptor' }));
    return nodeSock;
  };
  const harness: RelayMeshHarness = {
    relay,
    wsFactory,
    createTenant: (label, tenantOpts) => createTenant(harness, label, tenantOpts),
    // 注册放在 mesh 建好、start/login 之前：中途抛错也要能在 afterEach 里收干净
    bootNode: (label, boot) => bootNode(harness, label, boot, (node) => nodes.push(node)),
    async stop() {
      while (nodes.length > 0) await nodes.pop()?.close();
      restoreFetch();
      await relay.close();
    },
  };
  return harness;
}

async function bootNode(
  harness: RelayMeshHarness,
  label: string,
  boot: NodeBoot,
  register: (node: RelayMeshNode) => void
): Promise<RelayMeshNode> {
  const created = boot.db ? null : createMigratedAuthDb();
  const db = boot.db ?? created?.db;
  const close = boot.close ?? created?.close;
  if (!db || !close) throw new Error('missing node db');
  const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
  const userStore = new UserStore(db);
  // 节点名由 `hub join --name` 写进 node_identity，状态块据此展示；测试里直接用 label
  new MeshRelayStore(db).setLocalName(label);
  const mesh = await createMeshRuntime({
    db,
    gateway: fakeGateway(db, label),
    userId: boot.userId,
    config: {
      roles: boot.roles ?? NODE_ROLES,
      hubUrl: boot.hubUrl ?? null,
      hubPublicUrl: boot.hubPublicUrl ?? null,
      peerPort: 0,
      stunServers: [],
    },
    ...(boot.selfHub ? {} : { uplinkHub: null }),
    ...(boot.selfHub
      ? {
          patchHubRoleEnv: async () => {},
          scheduleHubRoleRestart: () => {},
          hubFetch: () => Promise.reject(new Error('no-hub-peers')),
        }
      : {}),
    wsFactory: boot.wsFactory ?? harness.wsFactory,
    startPeerServer: false,
    pingIntervalMs: 2_000,
    networkInterfaces: () => ({}),
    loadNative: async () => null,
    scheduler: new ShortBackoffScheduler(),
  });
  const relayStore = new MeshRelayStore(db);
  const node: RelayMeshNode = {
    label,
    mesh,
    db,
    userStore,
    keys: mesh.userKeyService,
    relayStore,
    nodeId: identity.nodeIdHex,
    cookie: '',
    call: (path, init) => callMesh(mesh, `http://self${path}`, { ...init, cookie: node.cookie }),
    async json<T>(path: string, init?: RequestInit) {
      const res = await node.call(path, init);
      if (res.status !== 200) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
      return (await res.json()) as T;
    },
    relayClient() {
      const live = mesh.uplink.liveClient();
      return live instanceof RelayUplinkClient ? live : null;
    },
    metaEpochs: () => relayStore.listSecretEpochs('meta'),
    async close() {
      await quietly(() => mesh.stop());
      // MeshRuntime.stop() 不管 HubRuntime（生产由 assemble 单独停），selfHub 节点要自己收
      await quietly(() => mesh.hub?.stop());
      // 记录应用触发的 reconcile 是异步的；直接关库会让飞行中的写入炸在 closed database
      await new Promise((resolve) => setTimeout(resolve, 50));
      await quietly(() => mesh.hub?.stop());
      close();
    },
  };
  register(node);
  await mesh.start();
  const sid = await loginSelf(mesh, {
    userId: boot.userId,
    rootKey: boot.rootKey,
    rootPublicKey: boot.rootKey.publicKey,
    rootEpoch: 0,
  });
  node.cookie = selfCookie(sid);
  return node;
}

async function quietly(fn: () => Promise<void> | undefined): Promise<void> {
  try {
    await fn();
  } catch {
    /* teardown 尽力而为 */
  }
}

async function createTenant(
  harness: RelayMeshHarness,
  label: string,
  opts: TenantOptions = {}
): Promise<RelayTenant> {
  const { db, close } = createMigratedAuthDb();
  const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
  const userStore = new UserStore(db);
  const bootstrap = new UserKeyService({
    db,
    userStore,
    keyLogStore: new KeyLogStore(db),
    nodeSessionStore: new NodeSessionStore(db),
    verifyPasskeyAssertion: makeVerifyPasskeyAssertion(userStore),
  });
  const boot = await bootstrap.bootstrapUserWithSelfAdmit({
    username: label,
    password: NODE_PASSWORD,
    identity,
  });
  const owner = await harness.bootNode(`${label}-a`, {
    userId: boot.userId,
    rootKey: boot.rootKey,
    db,
    close,
    ...(opts.roles ? { roles: opts.roles } : {}),
    ...(opts.hubUrl !== undefined ? { hubUrl: opts.hubUrl } : {}),
    ...(opts.hubPublicUrl !== undefined ? { hubPublicUrl: opts.hubPublicUrl } : {}),
    ...(opts.wsFactory ? { wsFactory: opts.wsFactory } : {}),
    ...(opts.selfHub ? { selfHub: true } : {}),
  });
  const tenant: RelayTenant = {
    label,
    userId: boot.userId,
    rootKey: boot.rootKey,
    rootPublicKey: boot.rootPublicKey,
    rootEpoch: boot.rootEpoch,
    owner,
    nodes: [owner],
    tenantId: () => owner.relayStore.listRelayRows()[0]?.tenantId ?? '',
    enrollRaw: (enrollOpts) => callRelayEnroll(tenant, { ...opts, ...enrollOpts }),
    async enroll(enrollOpts) {
      const res = await callRelayEnroll(tenant, { ...opts, ...enrollOpts });
      if (res.status !== 200) throw new Error(`relay enroll ${res.status}: ${await res.text()}`);
      await submitPrepared(tenant, res, 'set-relays');
      await waitUntil(() => owner.mesh.uplink.state === 'online', 8_000);
      await waitUntil(() => owner.metaEpochs().length > 0, 8_000);
      await waitRelayKeyLogSynced(harness, tenant);
    },
    joinNode: (nodeLabel) => joinNode(harness, tenant, nodeLabel),
    admit: (node) => admitNode(tenant, node),
    revoke: (node) => revokeNode(tenant, node),
    rotateMetaKey: (exclude) => rotateMetaKey(tenant, exclude),
    submitPrepared: (res, type) => submitPrepared(tenant, res, type),
    submitRecord: (node, type, payload) => submitRecord(tenant, node, type, payload),
  };
  return tenant;
}
