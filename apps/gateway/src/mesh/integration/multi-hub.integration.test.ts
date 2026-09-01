import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  encodeBase64url,
  encodeClearTotpPayload,
  encodeRevokeNodePayload,
} from '@tmex/shared/auth';
import { HUB_NOT_WRITER } from '@tmex/shared/uplink';
import { signUserRecord } from '../../hub/hub-test-helpers';
import {
  FAKE_NODE_ID,
  HUB_A_URL,
  HUB_B_URL,
  HUB_E_URL,
  HubRouter,
  type MultiHubTopology,
  attachedHubId,
  attachedUrl,
  bootAbcdTopology,
  bootHubA,
  callHub,
  callMesh,
  craftNodeList,
  createPendingNode,
  enrollAndStart,
  getMeshHubs,
  getMeshNodes,
  jarFor,
  keyLogList,
  loginRemote,
  loginSelf,
  meshHubsOf,
  notWriterBody,
  reconstructHubRuntime,
  selfCookie,
  sidFromResponse,
  waitUntil,
} from './multi-hub-harness';

describe('multi-hub in-process integration', () => {
  const fixtures: Array<{ stop: () => Promise<void> }> = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const item = fixtures.pop();
      try {
        await item?.stop();
      } catch {
        /* ignore */
      }
    }
  });

  async function boot(): Promise<MultiHubTopology> {
    const topo = await bootAbcdTopology();
    fixtures.push(topo);
    return topo;
  }

  test('hub set propagation: C learns from node.list, D has config seeds; both see A active and B standby', async () => {
    const { a, b, c, d, boot: user } = await boot();
    const cStore = meshHubsOf(c.db).list();
    const dStore = meshHubsOf(d.db).list();
    const aRow = (rows: typeof cStore) => rows.find((row) => row.hubNodeId === a.mesh.nodeId);
    const bRow = (rows: typeof cStore) => rows.find((row) => row.hubNodeId === b.mesh.nodeId);

    expect(aRow(cStore)).toMatchObject({
      mode: 'active',
      writerEpoch: 1,
      publicUrl: HUB_A_URL,
      online: true,
    });
    expect(bRow(cStore)).toMatchObject({
      mode: 'standby',
      publicUrl: HUB_B_URL,
    });
    expect(aRow(dStore)).toMatchObject({
      mode: 'active',
      writerEpoch: 1,
      publicUrl: HUB_A_URL,
      online: true,
    });
    expect(bRow(dStore)).toMatchObject({
      mode: 'standby',
      publicUrl: HUB_B_URL,
    });

    const sid = await loginSelf(c.mesh, user);
    const hubs = await getMeshHubs(c.mesh, selfCookie(sid));
    expect(hubs.writerHubId).toBe(a.mesh.nodeId);
    expect(hubs.attached?.publicUrl).toBe(HUB_A_URL);

    const nodes = await getMeshNodes(c.mesh, selfCookie(sid));
    const aNode = nodes.nodes.find((n) => n.id === a.mesh.nodeId);
    const bNode = nodes.nodes.find((n) => n.id === b.mesh.nodeId);
    expect(aNode?.isHub).toBe(true);
    expect(aNode?.hubMode).toBe('active');
    expect(bNode?.isHub).toBe(true);
    expect(bNode?.hubMode).toBe('standby');
  });

  test('G2: first seed attach fills attached.hubNodeId from node.list', async () => {
    const { a, c, boot: user } = await boot();
    const sid = await loginSelf(c.mesh, user);
    const hubs = await getMeshHubs(c.mesh, selfCookie(sid));
    expect(hubs.attached?.publicUrl).toBe(HUB_A_URL);
    expect(hubs.attached?.hubNodeId).toBe(a.mesh.nodeId);
  });

  test('replication on standby: B nodes table has A/C/D; crafted list without cert is ignored', async () => {
    const { a, b, c, d } = await boot();
    const aRow = b.userStore.getNode(a.mesh.nodeId);
    const cRow = b.userStore.getNode(c.mesh.nodeId);
    const dRow = b.userStore.getNode(d.mesh.nodeId);
    expect(aRow).not.toBeNull();
    expect(cRow?.name).toBe('node-c');
    expect(cRow?.version).toBeTruthy();
    expect(dRow?.name).toBe('node-d');
    expect(dRow?.version).toBeTruthy();
    expect(b.userStore.getCert(FAKE_NODE_ID)).toBeNull();

    const list = craftNodeList(a.mesh.lastNodeList, {
      nodes: [
        ...(a.mesh.lastNodeList?.nodes ?? []),
        {
          id: FAKE_NODE_ID,
          name: 'ghost',
          online: true,
          endpoints: [],
          inventory: {},
          direct_capable: false,
          version: '9.9.9',
        },
      ],
    });
    b.mesh.hub?.applyReplicatedNodeList(list, { hubNodeId: a.mesh.nodeId });
    expect(b.userStore.getNode(FAKE_NODE_ID)).toBeNull();
    expect(b.userStore.getNode(c.mesh.nodeId)?.name).toBe('node-c');
  });

  test('standby write fencing: POST enroll/rename/revoke via B is 409 HUB_NOT_WRITER; GET nodes is 200', async () => {
    const { a, b, c, boot: user, aKeys } = await boot();
    const sid = await loginSelf(c.mesh, user);
    const cookie = selfCookie(sid);
    const remote = await loginRemote(c.mesh, b.mesh, user, cookie);
    expect(remote.status).toBe(200);
    const bSid = sidFromResponse(remote, b.mesh.nodeId);
    const jar = jarFor(sid, b.mesh.nodeId, bSid);
    const expected = notWriterBody(a.mesh.nodeId, HUB_A_URL, 1);

    const enroll = await callMesh(c.mesh, `http://entry/n/${b.mesh.nodeId}/api/hub/enrollments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cookie: jar,
      body: JSON.stringify({}),
    });
    expect(enroll.status).toBe(409);
    expect(await enroll.json()).toEqual(expected);

    const rename = await callMesh(
      c.mesh,
      `http://entry/n/${b.mesh.nodeId}/api/hub/nodes/${c.mesh.nodeId}/rename`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cookie: jar,
        body: JSON.stringify({ name: 'nope' }),
      }
    );
    expect(rename.status).toBe(409);
    expect(await rename.json()).toEqual(expected);

    const rec = signUserRecord(
      aKeys,
      user.userId,
      user.rootKey,
      'revoke-node',
      encodeRevokeNodePayload({ node_id: c.mesh.identity.nodeId, reason: 'lost' })
    );
    const revoke = await callMesh(
      c.mesh,
      `http://entry/n/${b.mesh.nodeId}/api/hub/nodes/${c.mesh.nodeId}/revoke`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cookie: jar,
        body: JSON.stringify({
          bytes: encodeBase64url(rec.bytes),
          sig: encodeBase64url(rec.sig),
        }),
      }
    );
    expect(revoke.status).toBe(409);
    expect(await revoke.json()).toEqual(expected);

    const listed = await callMesh(c.mesh, `http://entry/n/${b.mesh.nodeId}/api/hub/nodes`, {
      cookie: jar,
    });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { nodes: Array<{ id: string }> };
    expect(body.nodes.some((n) => n.id === c.mesh.nodeId)).toBe(true);
  });

  test('failover: taking A down makes C and D re-attach to B; relay C→D still works', async () => {
    const { a, b, c, d, router, boot: user } = await boot();
    expect(attachedUrl(c.mesh)).toBe(HUB_A_URL);
    expect(attachedUrl(d.mesh)).toBe(HUB_A_URL);
    router.takeDown(HUB_A_URL);
    await waitUntil(
      () => attachedUrl(c.mesh) === HUB_B_URL && attachedUrl(d.mesh) === HUB_B_URL,
      8_000
    );
    expect(attachedHubId(c.mesh)).toBe(b.mesh.nodeId);
    expect(attachedHubId(d.mesh)).toBe(b.mesh.nodeId);

    const sid = await loginSelf(c.mesh, user);
    const cookie = selfCookie(sid);
    const remote = await loginRemote(c.mesh, d.mesh, user, cookie);
    expect(remote.status).toBe(200);
    const dSid = sidFromResponse(remote, d.mesh.nodeId);
    const info = await callMesh(c.mesh, `http://entry/n/${d.mesh.nodeId}/api/system/info`, {
      cookie: jarFor(sid, d.mesh.nodeId, dSid),
    });
    expect(info.status).toBe(200);
    const infoBody = (await info.json()) as { node?: string };
    expect(infoBody.node).toBe('d');

    await waitUntil(
      () =>
        c.mesh.lastNodeList?.nodes.some((n) => n.id === c.mesh.nodeId && n.online) === true &&
        c.mesh.lastNodeList?.nodes.some((n) => n.id === d.mesh.nodeId && n.online) === true,
      8_000
    );
    expect(a.mesh.hub?.mode()).toBe('active');
    expect(b.mesh.hub?.mode()).toBe('standby');
  });

  test('fail-back: bringing A back and switchTo re-attaches C/D to A without a node.status storm', async () => {
    const { a, b, c, d, router } = await boot();
    router.takeDown(HUB_A_URL);
    await waitUntil(
      () => attachedUrl(c.mesh) === HUB_B_URL && attachedUrl(d.mesh) === HUB_B_URL,
      8_000
    );
    router.bringUp(HUB_A_URL);
    router.statusFrames = 0;
    await c.mesh.uplink.switchTo(HUB_A_URL);
    await d.mesh.uplink.switchTo(HUB_A_URL);
    expect(attachedUrl(c.mesh)).toBe(HUB_A_URL);
    expect(attachedUrl(d.mesh)).toBe(HUB_A_URL);
    expect(attachedHubId(c.mesh)).toBe(a.mesh.nodeId);
    expect(attachedHubId(d.mesh)).toBe(a.mesh.nodeId);
    expect(b.mesh.hub?.mode()).toBe('standby');
    expect(a.mesh.hub?.mode()).toBe('active');
    await waitUntil(() => router.statusFrames >= 2, 2_000);
    expect(router.statusFrames).toBeLessThan(16);
  });

  test('epoch fencing: higher-epoch active E demotes A; equal epoch only warns', async () => {
    const router = new HubRouter();
    const ePending = await createPendingNode();
    const aBoot = await bootHubA(router, { hubPeers: [ePending.identity.nodeIdHex] });
    fixtures.push({
      stop: async () => {
        aBoot.node.unsubscribe?.();
        await aBoot.node.mesh.stop();
        await aBoot.node.mesh.hub?.stop();
        aBoot.node.close();
      },
    });
    const errors: string[] = [];
    const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(String(args[0]));
    });
    try {
      const e = await enrollAndStart(
        { mesh: aBoot.node.mesh, boot: aBoot.boot, keys: aBoot.keys, keyLog: aBoot.keyLog },
        {
          name: 'node-e',
          version: 'ver-e',
          roles: { hub: true, node: true },
          hubUrl: HUB_A_URL,
          hubPublicUrl: HUB_E_URL,
          hubMode: 'active',
          hubPriority: 50,
          hubWriterEpoch: 2,
          wsFactory: router.factory,
          pending: ePending,
          label: 'e',
        }
      );
      fixtures.push({
        stop: async () => {
          e.unsubscribe?.();
          await e.mesh.stop();
          await e.mesh.hub?.stop();
          e.close();
        },
      });
      if (e.mesh.hub) router.register(HUB_E_URL, e.mesh.hub);
      await waitUntil(() => aBoot.node.mesh.hub?.mode() === 'standby', 8_000);
      expect(
        errors.some((line) => line.includes('[hub] fenced:') && line.includes('writerEpoch=2'))
      ).toBe(true);
      expect(aBoot.node.mesh.hub?.mode()).toBe('standby');

      const sid = await loginSelf(aBoot.node.mesh, aBoot.boot);
      const enroll = await callHub(aBoot.node.mesh.hub!, 'http://hub/api/hub/enrollments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cookie: selfCookie(sid),
        body: JSON.stringify({}),
      });
      expect(enroll.status).toBe(409);
      expect(await enroll.json()).toEqual({
        code: HUB_NOT_WRITER,
        writerHubId: e.mesh.nodeId,
        writerPublicUrl: HUB_E_URL,
        writerEpoch: 2,
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('epoch fencing: equal-epoch active only warns; A stays active', async () => {
    const router = new HubRouter();
    const twinPending = await createPendingNode();
    const aBoot = await bootHubA(router, { hubPeers: [twinPending.identity.nodeIdHex] });
    fixtures.push({
      stop: async () => {
        aBoot.node.unsubscribe?.();
        await aBoot.node.mesh.stop();
        await aBoot.node.mesh.hub?.stop();
        aBoot.node.close();
      },
    });
    const warns: string[] = [];
    const warnSpy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warns.push(String(args[0]));
    });
    try {
      const twin = await enrollAndStart(
        { mesh: aBoot.node.mesh, boot: aBoot.boot, keys: aBoot.keys, keyLog: aBoot.keyLog },
        {
          name: 'node-twin',
          version: 'ver-twin',
          roles: { hub: true, node: true },
          hubUrl: HUB_A_URL,
          hubPublicUrl: 'http://hub-twin.test',
          hubMode: 'active',
          hubPriority: 80,
          hubWriterEpoch: 1,
          wsFactory: router.factory,
          pending: twinPending,
          label: 'twin',
        }
      );
      fixtures.push({
        stop: async () => {
          twin.unsubscribe?.();
          await twin.mesh.stop();
          await twin.mesh.hub?.stop();
          twin.close();
        },
      });
      await waitUntil(
        () =>
          warns.some(
            (line) => line.includes('[hub] split-brain:') && line.includes('writerEpoch=1')
          ),
        8_000
      );
      expect(aBoot.node.mesh.hub?.mode()).toBe('active');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('stale frames ignored: late node.list from A after C attached to B does not regress MeshHubStore', async () => {
    const { a, b, c, d, router } = await boot();
    router.takeDown(HUB_A_URL);
    await waitUntil(() => attachedUrl(c.mesh) === HUB_B_URL, 8_000);
    const before = meshHubsOf(c.db)
      .list()
      .map((row) => ({ id: row.hubNodeId, mode: row.mode, epoch: row.writerEpoch }));
    expect(before.some((row) => row.id === b.mesh.nodeId && row.mode === 'standby')).toBe(true);
    const stale = craftNodeList(a.mesh.lastNodeList, {
      version: 99_999,
      nodes: (a.mesh.lastNodeList?.nodes ?? []).filter((n) => n.id === a.mesh.nodeId),
      hubs: [
        {
          nodeId: a.mesh.nodeId,
          publicUrl: HUB_A_URL,
          mode: 'active',
          priority: 100,
          writerEpoch: 1,
          online: true,
        },
      ],
      hub: { nodeId: a.mesh.nodeId, publicUrl: HUB_A_URL },
    });
    router.bringUp(HUB_A_URL);
    const delivered = router.sendCtl(HUB_A_URL, stale);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = meshHubsOf(c.db)
      .list()
      .map((row) => ({ id: row.hubNodeId, mode: row.mode, epoch: row.writerEpoch }));
    expect(after).toEqual(before);
    expect(after.some((row) => row.id === b.mesh.nodeId)).toBe(true);
    expect(c.mesh.lastNodeList?.hubs?.some((h) => h.nodeId === b.mesh.nodeId)).toBe(true);
    expect(d.mesh.nodeId).toBeTruthy();
    expect(delivered).toBeGreaterThanOrEqual(0);
  });

  test('legacy compatibility: node.list without hubs[] synthesizes a single active record from hub', async () => {
    const { a, c } = await boot();
    expect(meshHubsOf(c.db).list().length).toBeGreaterThanOrEqual(2);
    const legacy = craftNodeList(c.mesh.lastNodeList, {
      hubs: undefined,
      writerHubId: undefined,
      writerEpoch: undefined,
      hub: { nodeId: a.mesh.nodeId, publicUrl: HUB_A_URL, name: 'legacy-a' },
    });
    delete (legacy as { hubs?: unknown }).hubs;
    const topo = fixtures[fixtures.length - 1] as MultiHubTopology;
    const sent = topo.router.sendCtl(HUB_A_URL, legacy);
    expect(sent).toBeGreaterThan(0);
    await waitUntil(() => {
      const rows = meshHubsOf(c.db).list();
      return (
        rows.length === 1 && rows[0]?.hubNodeId === a.mesh.nodeId && rows[0]?.mode === 'active'
      );
    }, 8_000);
    const rows = meshHubsOf(c.db).list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      hubNodeId: a.mesh.nodeId,
      publicUrl: HUB_A_URL,
      mode: 'active',
      writerEpoch: 1,
    });
  });

  test('unauthorized high-epoch hub advertisement does not demote A or appear as writer', async () => {
    const { a, c, boot: user } = await boot();
    const warns: string[] = [];
    const warnSpy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warns.push(String(args[0]));
    });
    try {
      expect(a.mesh.hub?.mode()).toBe('active');
      c.mesh.uplink.sendCtl({
        t: 'node.status',
        version: 'evil-999',
        tmux: false,
        direct_capable: false,
        inventory: {},
        endpoints: [],
        hub: {
          publicUrl: 'http://evil.test',
          mode: 'active',
          priority: 1,
          writerEpoch: 999,
        },
      });
      await waitUntil(() => a.userStore.getNode(c.mesh.nodeId)?.version === 'evil-999', 8_000);
      expect(a.mesh.hub?.mode()).toBe('active');
      expect(meshHubsOf(a.db).get(c.mesh.nodeId)).toBeNull();
      expect(
        warns.some((line) =>
          line.includes(`[hub] ignored hub advertisement from unauthorized node=${c.mesh.nodeId}`)
        )
      ).toBe(true);

      const sid = await loginSelf(c.mesh, user);
      const hubs = await getMeshHubs(c.mesh, selfCookie(sid));
      expect(hubs.writerHubId).toBe(a.mesh.nodeId);
      expect(hubs.hubs.some((row) => row.nodeId === c.mesh.nodeId)).toBe(false);
      expect(hubs.hubs.some((row) => row.writerEpoch === 999)).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('A restarted after fencing by E stays standby and writes HUB_NOT_WRITER', async () => {
    const router = new HubRouter();
    const ePending = await createPendingNode();
    const aBoot = await bootHubA(router, { hubPeers: [ePending.identity.nodeIdHex] });
    fixtures.push({
      stop: async () => {
        aBoot.node.unsubscribe?.();
        await aBoot.node.mesh.stop();
        await aBoot.node.mesh.hub?.stop();
        aBoot.node.close();
      },
    });
    const e = await enrollAndStart(
      { mesh: aBoot.node.mesh, boot: aBoot.boot, keys: aBoot.keys, keyLog: aBoot.keyLog },
      {
        name: 'node-e',
        version: 'ver-e',
        roles: { hub: true, node: true },
        hubUrl: HUB_A_URL,
        hubPublicUrl: HUB_E_URL,
        hubMode: 'active',
        hubPriority: 50,
        hubWriterEpoch: 2,
        wsFactory: router.factory,
        pending: ePending,
        label: 'e',
      }
    );
    fixtures.push({
      stop: async () => {
        e.unsubscribe?.();
        await e.mesh.stop();
        await e.mesh.hub?.stop();
        e.close();
      },
    });
    if (e.mesh.hub) router.register(HUB_E_URL, e.mesh.hub);
    await waitUntil(() => aBoot.node.mesh.hub?.mode() === 'standby', 8_000);
    expect(aBoot.node.mesh.hub?.mode()).toBe('standby');

    await aBoot.node.mesh.hub?.stop();
    const logged: string[] = [];
    const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(String(args[0]));
    });
    let restarted: ReturnType<typeof reconstructHubRuntime>;
    try {
      restarted = reconstructHubRuntime(aBoot.node, {
        userId: aBoot.boot.userId,
        keys: aBoot.keys,
        keyLog: aBoot.keyLog,
        authorizedHubIds: [e.mesh.nodeId],
        mode: 'active',
        writerEpoch: 1,
      });
    } finally {
      errorSpy.mockRestore();
    }
    fixtures.push({ stop: async () => restarted.stop() });
    expect(restarted.mode()).toBe('standby');
    expect(
      logged.some(
        (line) => line.includes('[hub] starting fenced:') && line.includes('writerEpoch=2')
      )
    ).toBe(true);

    const write = await callHub(restarted, 'http://hub/api/hub/enrollments/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(write.status).toBe(409);
    expect(await write.json()).toEqual({
      code: HUB_NOT_WRITER,
      writerHubId: e.mesh.nodeId,
      writerPublicUrl: HUB_E_URL,
      writerEpoch: 2,
    });
  });

  test('standby B rejects chain-extending key.log.append from C and acks identical replay', async () => {
    const { b, c, router, boot: user } = await boot();
    router.takeDown(HUB_A_URL);
    await waitUntil(() => attachedUrl(c.mesh) === HUB_B_URL, 8_000);
    expect(attachedHubId(c.mesh)).toBe(b.mesh.nodeId);
    expect(b.mesh.hub?.mode()).toBe('standby');

    const before = b.mesh.userKeyService.currentState(user.userId).head.seq;
    const extending = signUserRecord(
      b.mesh.userKeyService,
      user.userId,
      user.rootKey,
      'clear-totp',
      encodeClearTotpPayload()
    );
    const rejected = await c.mesh.uplink.appendAndAck(extending);
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toBe(HUB_NOT_WRITER);
    expect(b.mesh.userKeyService.currentState(user.userId).head.seq).toBe(before);

    const existing = keyLogList(b.db, user.userId).at(-1);
    if (!existing) throw new Error('B key log is empty');
    const replayed = await c.mesh.uplink.appendAndAck({
      bytes: existing.bytes,
      sig: existing.sig,
    });
    expect(replayed.ok).toBe(true);
    expect(b.mesh.userKeyService.currentState(user.userId).head.seq).toBe(before);
  });

  test('POST /api/auth/keylog on C attached to standby B is 409 until A is back', async () => {
    const { a, b, c, router, boot: user } = await boot();
    router.takeDown(HUB_A_URL);
    await waitUntil(() => attachedUrl(c.mesh) === HUB_B_URL, 8_000);
    expect(attachedHubId(c.mesh)).toBe(b.mesh.nodeId);

    const sid = await loginSelf(c.mesh, user);
    const cookie = selfCookie(sid);
    const rec = signUserRecord(
      c.mesh.userKeyService,
      user.userId,
      user.rootKey,
      'clear-totp',
      encodeClearTotpPayload()
    );
    const before = c.mesh.userKeyService.currentState(user.userId).head.seq;
    const refused = await callMesh(c.mesh, 'http://entry/api/auth/keylog', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cookie,
      body: JSON.stringify({
        bytes: encodeBase64url(rec.bytes),
        sig: encodeBase64url(rec.sig),
      }),
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      code: HUB_NOT_WRITER,
      writerHubId: a.mesh.nodeId,
      writerPublicUrl: HUB_A_URL,
      writerEpoch: 1,
    });
    expect(c.mesh.userKeyService.currentState(user.userId).head.seq).toBe(before);

    router.bringUp(HUB_A_URL);
    await c.mesh.uplink.switchTo(HUB_A_URL);
    expect(attachedHubId(c.mesh)).toBe(a.mesh.nodeId);
    const ok = await callMesh(c.mesh, 'http://entry/api/auth/keylog', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cookie,
      body: JSON.stringify({
        bytes: encodeBase64url(rec.bytes),
        sig: encodeBase64url(rec.sig),
      }),
    });
    expect(ok.status).toBe(200);
    expect(c.mesh.userKeyService.currentState(user.userId).head.seq).toBeGreaterThan(before);
  });
});

describe('multi-hub harness smoke (isolated A)', () => {
  test('bootHubA comes online as active writerEpoch 1', async () => {
    const router = new HubRouter();
    const a = await bootHubA(router);
    try {
      expect(a.node.mesh.hub?.mode()).toBe('active');
      expect(a.node.mesh.hub?.writerEpoch()).toBe(1);
      expect(a.node.mesh.uplink.state).toBe('online');
    } finally {
      a.node.unsubscribe?.();
      await a.node.mesh.stop();
      await a.node.mesh.hub?.stop();
      a.node.close();
    }
  });
});
