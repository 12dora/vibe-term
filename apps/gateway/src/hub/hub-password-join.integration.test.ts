import { afterEach, describe, expect, test } from 'bun:test';
import { performHubJoin } from '../../../../packages/app/src/commands/hub';
import {
  requestEnrollmentByPassword,
  wipeRootKey,
} from '../../../../packages/app/src/lib/hub-password-join';
import { publishHubJoinSelfAdmit } from '../../../../packages/app/src/lib/hub-password-self-admit';
import { createAuthContextFromDb } from '../../../../packages/app/src/lib/local-auth';
import {
  KeyLogStore,
  NodeIdentityStore,
  NodeSessionStore,
  UserKeyService,
  UserStore,
  ensureNodeIdentity,
  makeVerifyPasskeyAssertion,
} from '../auth';
import { createMigratedAuthDb } from '../auth/test-db';
import type { AuthDb } from '../auth/types';
import { MESH_VIA_SELF, setMeshRequestContext } from '../mesh/mesh-deps';
import { type MeshRuntime, createMeshRuntime } from '../mesh/mesh-runtime';
import { waitUntil } from '../mesh/test-support';
import type { GatewayRuntime } from '../runtime';
import type { WebSocketServer } from '../ws';

const PASSWORD = 'tmex-test';
const HUB_URL = 'https://hub.example';
const dummyServer = { upgrade: () => false };

function fakeGateway(db: AuthDb): GatewayRuntime {
  return {
    port: 0,
    db,
    wsServer: {} as WebSocketServer,
    handleRequest: () => undefined,
    dispatchHttp: async () => new Response('not-found', { status: 404 }),
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

function hubFetcher(mesh: MeshRuntime) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const req = new Request(`${HUB_URL}${url.pathname}${url.search}`, init);
    setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp: '127.0.0.1' });
    if (url.pathname.startsWith('/api/hub/')) {
      const res = await mesh.hub?.handleRequest(req, dummyServer);
      if (!(res instanceof Response)) throw new Error(`unhandled hub ${url.pathname}`);
      return res;
    }
    const res = await mesh.handleRequest(req, dummyServer);
    if (!(res instanceof Response)) throw new Error(`unhandled ${url.pathname}`);
    return res;
  };
}

describe('hub password join self-admit', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];
  afterEach(async () => {
    while (fixtures.length > 0) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  test('password join admits the node so uplink authenticates', async () => {
    const hubDb = createMigratedAuthDb();
    const hubIdentity = await ensureNodeIdentity(new NodeIdentityStore(hubDb.db));
    const hubUsers = new UserStore(hubDb.db);
    const hubKeys = new UserKeyService({
      db: hubDb.db,
      userStore: hubUsers,
      keyLogStore: new KeyLogStore(hubDb.db),
      nodeSessionStore: new NodeSessionStore(hubDb.db),
      verifyPasskeyAssertion: makeVerifyPasskeyAssertion(hubUsers),
    });
    const boot = await hubKeys.bootstrapUserWithSelfAdmit({
      username: 'alice',
      password: PASSWORD,
      identity: hubIdentity,
    });
    const hubMesh = await createMeshRuntime({
      db: hubDb.db,
      gateway: fakeGateway(hubDb.db),
      userId: boot.userId,
      config: {
        roles: { hub: true, node: true, relay: false },
        hubUrl: null,
        hubPublicUrl: HUB_URL,
        peerPort: 39011,
        stunServers: [],
      },
      startPeerServer: false,
      pingIntervalMs: 60_000,
      networkInterfaces: () => ({}),
      loadNative: async () => null,
    });
    fixtures.push({ close: hubDb.close, stop: () => hubMesh.stop() });
    await hubMesh.start();
    await waitUntil(() => hubMesh.uplink.state === 'online', 5_000);

    const joinDb = createMigratedAuthDb();
    const auth = await createAuthContextFromDb(joinDb.db, { close: joinDb.close });
    fixtures.push({ close: joinDb.close });
    const fetcher = hubFetcher(hubMesh);
    const material = await requestEnrollmentByPassword({
      hubUrl: HUB_URL,
      password: PASSWORD,
      fetcher,
    });
    try {
      const joined = await performHubJoin(
        { hubUrl: HUB_URL, token: material.token, name: 'studio' },
        { auth, fetcher }
      );
      await publishHubJoinSelfAdmit({
        auth,
        hubUrl: joined.hubUrl,
        userId: joined.userId,
        rootKey: material.rootKey!,
        fetcher,
      });
    } finally {
      wipeRootKey(material.rootKey);
    }

    const joinerId = (await auth.identityStore.load())?.nodeId;
    if (!joinerId) throw new Error('joiner identity missing');
    expect(hubUsers.getCert(joinerId)).not.toBeNull();
    expect(hubUsers.getCert(joinerId)?.revokedLogSeq).toBeNull();

    const nodeMesh = await createMeshRuntime({
      db: joinDb.db,
      gateway: fakeGateway(joinDb.db),
      userId: boot.userId,
      config: {
        roles: { hub: false, node: true, relay: false },
        hubUrl: HUB_URL,
        peerPort: 39012,
        stunServers: [],
      },
      uplinkHub: hubMesh.hub ?? undefined,
      startPeerServer: false,
      pingIntervalMs: 60_000,
      networkInterfaces: () => ({}),
      loadNative: async () => null,
    });
    fixtures.push({ stop: () => nodeMesh.stop(), close: () => {} });
    await nodeMesh.start();
    await waitUntil(() => nodeMesh.uplink.state === 'online', 8_000);
    expect(nodeMesh.uplink.state).toBe('online');
  }, 30_000);
});
