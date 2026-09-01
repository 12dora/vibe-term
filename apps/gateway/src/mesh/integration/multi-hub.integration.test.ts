import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  KEYLOG_TYPE_UNSUPPORTED_BY_NODES,
  MIN_HUB_AUTH_RECORD_VERSION,
  buildAdmitHubPayload,
  buildRetireHubPayload,
  createEnrollment,
  createNodeCertificate,
  encodeBase64url,
  encodeClearTotpPayload,
  encodeRevokeNodePayload,
  hexToBytes,
} from '@tmex/shared/auth';
import { HUB_NOT_WRITER, TMEX_FORWARDED_BY_HEADER } from '@tmex/shared/uplink';
import { signUserRecord } from '../../hub/hub-test-helpers';
import { decodeUplinkCtl } from '../uplink-protocol';
import {
  FAKE_NODE_ID,
  HUB_A_URL,
  HUB_B_URL,
  HUB_E_URL,
  HubRouter,
  type MultiHubTopology,
  attachSplitAbcd,
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
  reconstructHubRuntime,
  selfCookie,
  sidFromResponse,
  stampHubCtlVersions,
  stampNodeVersions,
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

  test('enroll through standby B while A is writer: request is forwarded and node can join', async () => {
    const { a, b, c, boot: user } = await boot();
    stampHubCtlVersions({ a, b });
    const sid = await loginSelf(c.mesh, user);
    const cookie = selfCookie(sid);
    const remote = await loginRemote(c.mesh, b.mesh, user, cookie);
    expect(remote.status).toBe(200);
    const bSid = sidFromResponse(remote, b.mesh.nodeId);
    const jar = jarFor(sid, b.mesh.nodeId, bSid);

    const now = Date.now();
    const enrollment = await createEnrollment(user.rootKey, {
      uid: user.userId,
      rootEpoch: user.rootEpoch,
      now,
      ttlMs: 60_000,
    });
    const enroll = await callMesh(c.mesh, `http://entry/n/${b.mesh.nodeId}/api/hub/enrollments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cookie: jar,
      body: JSON.stringify({
        enroll_pk: encodeBase64url(enrollment.enrollPk),
        authorization: encodeBase64url(enrollment.authorizationBytes),
        authorization_sig: encodeBase64url(enrollment.authorizationSig),
        exp: now + 60_000,
      }),
    });
    expect(enroll.status).toBe(201);
    expect(enroll.headers.get(TMEX_FORWARDED_BY_HEADER)).toBe(b.mesh.nodeId);
    const created = (await enroll.json()) as { id: string };
    expect(a.userStore.getEnrollmentTokenById(created.id)).not.toBeNull();

    const pending = await createPendingNode();
    const cert = createNodeCertificate(enrollment.enrollSk, {
      uid: user.userId,
      edPk: pending.identity.edPublicKey,
      x25519Pk: pending.identity.x25519PublicKey,
      enrollPk: enrollment.enrollPk,
      now,
      nodeId: pending.identity.nodeId,
    });
    const redeemed = await callMesh(
      c.mesh,
      `http://entry/n/${b.mesh.nodeId}/api/hub/enrollments/redeem`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cookie: jar,
        body: JSON.stringify({
          certificate: encodeBase64url(cert.certificateBytes),
          cert_sig: encodeBase64url(cert.certSig),
          name: 'via-b',
          version: '1.1.13',
        }),
      }
    );
    expect(redeemed.status).toBe(200);
    expect(a.userStore.getNode(pending.identity.nodeIdHex)?.name).toBe('via-b');
    pending.close();

    const listed = await callMesh(c.mesh, `http://entry/n/${b.mesh.nodeId}/api/hub/nodes`, {
      cookie: jar,
    });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { nodes: Array<{ id: string }> };
    expect(body.nodes.some((n) => n.id === c.mesh.nodeId)).toBe(true);
  });

  test('token created on A survives A crash: B promoted via role API can redeem', async () => {
    const topo = await boot();
    const { a, b, boot: user, router } = topo;
    a.mesh.hub?.registry.updateMeta(b.mesh.nodeId, { version: '1.1.13' }, Date.now());
    const aSid = await loginSelf(a.mesh, user);
    const now = Date.now();
    const enrollment = await createEnrollment(user.rootKey, {
      uid: user.userId,
      rootEpoch: user.rootEpoch,
      now,
      ttlMs: 60_000,
    });
    const created = await callHub(a.mesh.hub!, 'http://hub/api/hub/enrollments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cookie: selfCookie(aSid),
      body: JSON.stringify({
        enroll_pk: encodeBase64url(enrollment.enrollPk),
        authorization: encodeBase64url(enrollment.authorizationBytes),
        authorization_sig: encodeBase64url(enrollment.authorizationSig),
        exp: now + 60_000,
      }),
    });
    expect(created.status).toBe(201);
    const tokenId = ((await created.json()) as { id: string }).id;
    await waitUntil(() => b.userStore.getEnrollmentTokenById(tokenId) != null, 4_000);

    router.takeDown(HUB_A_URL);
    const bSid = await loginSelf(b.mesh, user);
    const promote = await callHub(b.mesh.hub!, 'http://hub/api/hub/role', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cookie: selfCookie(bSid),
      body: JSON.stringify({
        mode: 'active',
        writerEpoch: 2,
        operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }),
    });
    expect(promote.status).toBe(202);
    expect(b.mesh.hub?.mode()).toBe('active');

    const pending = await createPendingNode();
    const cert = createNodeCertificate(enrollment.enrollSk, {
      uid: user.userId,
      edPk: pending.identity.edPublicKey,
      x25519Pk: pending.identity.x25519PublicKey,
      enrollPk: enrollment.enrollPk,
      now,
      nodeId: pending.identity.nodeId,
    });
    const redeemed = await callHub(b.mesh.hub!, 'http://hub/api/hub/enrollments/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        certificate: encodeBase64url(cert.certificateBytes),
        cert_sig: encodeBase64url(cert.certSig),
        name: 'after-promote',
        version: '1.1.13',
      }),
    });
    expect(redeemed.status).toBe(200);
    expect(b.userStore.getNode(pending.identity.nodeIdHex)?.name).toBe('after-promote');
    pending.close();
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
      expect(enroll.status).not.toBe(201);
      if (enroll.status === 409) {
        expect(await enroll.json()).toEqual({
          code: HUB_NOT_WRITER,
          writerHubId: e.mesh.nodeId,
          writerPublicUrl: HUB_E_URL,
          writerEpoch: 2,
        });
      } else {
        expect(enroll.headers.get(TMEX_FORWARDED_BY_HEADER)).toBe(aBoot.node.mesh.nodeId);
      }
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

  test('admit-hub record lists standby without env; retire drops it and fences self', async () => {
    const router = new HubRouter();
    const bPending = await createPendingNode();
    const aBoot = await bootHubA(router);
    fixtures.push({
      stop: async () => {
        aBoot.node.unsubscribe?.();
        await aBoot.node.mesh.stop();
        await aBoot.node.mesh.hub?.stop();
        aBoot.node.close();
      },
    });
    const parent = {
      mesh: aBoot.node.mesh,
      boot: aBoot.boot,
      keys: aBoot.keys,
      keyLog: aBoot.keyLog,
    };
    const b = await enrollAndStart(parent, {
      name: 'node-b',
      version: '1.1.13',
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
    });
    fixtures.push({
      stop: async () => {
        b.unsubscribe?.();
        await b.mesh.stop();
        await b.mesh.hub?.stop();
        b.close();
      },
    });
    stampNodeVersions(aBoot.node.db, '1.1.13');
    expect(meshHubsOf(aBoot.node.db).get(b.mesh.nodeId)).toBeNull();

    const keys = aBoot.node.mesh.userKeyService;
    const admitted = await keys.signAndApply(aBoot.boot.userId, aBoot.boot.rootKey, {
      type: 'admit-hub',
      payload: buildAdmitHubPayload({
        hubNodeId: hexToBytes(b.mesh.nodeId),
        publicUrl: HUB_B_URL,
        priority: 200,
      }),
    });
    expect(admitted.ok).toBe(true);
    const listed = meshHubsOf(aBoot.node.db).get(b.mesh.nodeId);
    expect(listed?.publicUrl).toBe(HUB_B_URL);
    const sid = await loginSelf(aBoot.node.mesh, aBoot.boot);
    const hubs = await getMeshHubs(aBoot.node.mesh, selfCookie(sid));
    expect(hubs.hubs.find((row) => row.nodeId === b.mesh.nodeId)?.authorization).toBe('signed');

    const retired = await keys.signAndApply(aBoot.boot.userId, aBoot.boot.rootKey, {
      type: 'retire-hub',
      payload: buildRetireHubPayload({ hubNodeId: hexToBytes(b.mesh.nodeId) }),
    });
    expect(retired.ok).toBe(true);
    expect(meshHubsOf(aBoot.node.db).get(b.mesh.nodeId)).toBeNull();

    const selfAdmit = await keys.signAndApply(aBoot.boot.userId, aBoot.boot.rootKey, {
      type: 'admit-hub',
      payload: buildAdmitHubPayload({
        hubNodeId: hexToBytes(aBoot.node.mesh.nodeId),
        publicUrl: HUB_A_URL,
      }),
    });
    expect(selfAdmit.ok).toBe(true);
    const selfRetire = await keys.signAndApply(aBoot.boot.userId, aBoot.boot.rootKey, {
      type: 'retire-hub',
      payload: buildRetireHubPayload({ hubNodeId: hexToBytes(aBoot.node.mesh.nodeId) }),
    });
    expect(selfRetire.ok).toBe(true);
    expect(aBoot.node.mesh.hub?.mode()).toBe('standby');
  });

  test('writer refuses admit-hub while an old-version node is present', async () => {
    const { a, c, boot: user } = await boot();
    stampNodeVersions(a.db, '1.1.13', new Set([c.mesh.nodeId]));
    const rec = signUserRecord(
      a.mesh.userKeyService,
      user.userId,
      user.rootKey,
      'admit-hub',
      buildAdmitHubPayload({
        hubNodeId: hexToBytes(c.mesh.nodeId),
        publicUrl: 'https://c.example',
      })
    );
    const sid = await loginSelf(a.mesh, user);
    const cookie = selfCookie(sid);
    const refused = await callMesh(a.mesh, 'http://entry/api/auth/keylog', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cookie,
      body: JSON.stringify({
        bytes: encodeBase64url(rec.bytes),
        sig: encodeBase64url(rec.sig),
      }),
    });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as {
      code: string;
      minVersion: string;
      nodes: Array<{ id: string; version: string | null }>;
    };
    expect(body.code).toBe(KEYLOG_TYPE_UNSUPPORTED_BY_NODES);
    expect(body.minVersion).toBe(MIN_HUB_AUTH_RECORD_VERSION);
    expect(body.nodes.some((n) => n.id === c.mesh.nodeId)).toBe(true);

    const forced = await callMesh(a.mesh, 'http://entry/api/auth/keylog', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Tmex-Force-Keylog': '1' },
      cookie,
      body: JSON.stringify({
        bytes: encodeBase64url(rec.bytes),
        sig: encodeBase64url(rec.sig),
      }),
    });
    expect(forced.status).toBe(200);
  });

  test('API demote A then promote B: C/D switch to B; A reconstructed with old env is fenced', async () => {
    const topo = await boot();
    const { a, b, c, d, boot: user, router } = topo;
    const sid = await loginSelf(a.mesh, user);
    const cookie = selfCookie(sid);
    const demoteOp = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const promoteOp = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    const demote = await callHub(a.mesh.hub!, 'http://hub/api/hub/role', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cookie,
      body: JSON.stringify({ mode: 'standby', operationId: demoteOp }),
    });
    expect(demote.status).toBe(202);
    expect(await demote.json()).toMatchObject({
      operationId: demoteOp,
      mode: 'standby',
      phase: 'restarting',
    });
    expect(a.mesh.hub?.mode()).toBe('standby');
    expect(a.roleEnv?.TMEX_HUB_MODE).toBe('standby');
    expect(a.roleRestarts?.length).toBe(1);

    const bSid = await loginSelf(b.mesh, user);
    const promote = await callHub(b.mesh.hub!, 'http://hub/api/hub/role', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cookie: selfCookie(bSid),
      body: JSON.stringify({ mode: 'active', writerEpoch: 2, operationId: promoteOp }),
    });
    expect(promote.status).toBe(202);
    expect(await promote.json()).toMatchObject({
      operationId: promoteOp,
      mode: 'active',
      writerEpoch: 2,
      phase: 'restarting',
    });
    expect(b.mesh.hub?.mode()).toBe('active');
    expect(b.mesh.hub?.writerEpoch()).toBe(2);
    expect(b.roleEnv?.TMEX_HUB_MODE).toBe('active');
    expect(b.roleEnv?.TMEX_HUB_WRITER_EPOCH).toBe('2');

    router.takeDown(HUB_A_URL);
    await waitUntil(
      () => attachedUrl(c.mesh) === HUB_B_URL && attachedUrl(d.mesh) === HUB_B_URL,
      8_000
    );
    expect(attachedHubId(c.mesh)).toBe(b.mesh.nodeId);
    expect(attachedHubId(d.mesh)).toBe(b.mesh.nodeId);

    await a.mesh.hub?.stop();
    const logged: string[] = [];
    const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(String(args[0]));
    });
    let restarted: ReturnType<typeof reconstructHubRuntime>;
    try {
      restarted = reconstructHubRuntime(a, {
        userId: user.userId,
        keys: topo.aKeys,
        keyLog: topo.aKeyLog,
        authorizedHubIds: [b.mesh.nodeId],
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
  }, 20_000);

  test('G6: A down long enough → B auto-promotes → A returns fenced', async () => {
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
      hubAutoPromote: true,
      hubAutoPromoteTimeoutMs: 20,
    });
    if (!b.mesh.hub) throw new Error('hub B missing HubRuntime');
    router.register(HUB_B_URL, b.mesh.hub);
    fixtures.push({
      stop: async () => {
        await b.mesh.stop();
        b.close();
        await aBoot.node.mesh.stop();
        aBoot.node.close();
      },
    });
    await waitUntil(() => meshHubsOf(b.db).get(aBoot.node.mesh.nodeId)?.mode === 'active', 8_000);

    router.takeDown(HUB_A_URL);
    const autoLogs: string[] = [];
    const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      autoLogs.push(String(args[0]));
    });
    try {
      await b.mesh.hub.pollPeersNow();
      await Bun.sleep(25);
      await b.mesh.hub.pollPeersNow();
    } finally {
      errorSpy.mockRestore();
    }
    expect(b.mesh.hub.mode()).toBe('active');
    expect(b.mesh.hub.writerEpoch()).toBeGreaterThan(1);
    expect(b.roleEnv?.TMEX_HUB_MODE).toBe('active');
    expect(autoLogs.some((line) => line.includes('[hub] auto-promote'))).toBe(true);

    await aBoot.node.mesh.hub?.stop();
    const fenceLogs: string[] = [];
    const fenceSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      fenceLogs.push(String(args[0]));
    });
    let restarted: ReturnType<typeof reconstructHubRuntime>;
    try {
      restarted = reconstructHubRuntime(aBoot.node, {
        userId: aBoot.boot.userId,
        keys: aBoot.keys,
        keyLog: aBoot.keyLog,
        authorizedHubIds: [b.mesh.nodeId],
        mode: 'active',
        writerEpoch: 1,
        fetchPeerStatus: router.fetch,
      });
      await restarted.pollPeersNow();
    } finally {
      fenceSpy.mockRestore();
    }
    fixtures.push({ stop: async () => restarted.stop() });
    expect(restarted.mode()).toBe('standby');
    expect(
      fenceLogs.some((line) => line.includes('[hub] fenced') || line.includes('writerEpoch='))
    ).toBe(true);
  }, 20_000);

  test('G5: C on A and D on B can HTTP-relay both ways, rtc.signal round-trip, A down rebuilds route', async () => {
    const topo = await boot();
    const { a, b, c, d, router, boot: user } = topo;
    await attachSplitAbcd(topo);
    expect(attachedHubId(c.mesh)).toBe(a.mesh.nodeId);
    expect(attachedHubId(d.mesh)).toBe(b.mesh.nodeId);

    const cSid = await loginSelf(c.mesh, user);
    const nodes = await getMeshNodes(c.mesh, selfCookie(cSid));
    expect(nodes.nodes.find((n) => n.id === d.mesh.nodeId)?.attachedHubId).toBe(b.mesh.nodeId);

    const remote = await loginRemote(c.mesh, d.mesh, user, selfCookie(cSid));
    expect(remote.status).toBe(200);
    const dSid = sidFromResponse(remote, d.mesh.nodeId);
    const info = await callMesh(c.mesh, `http://entry/n/${d.mesh.nodeId}/api/system/info`, {
      cookie: jarFor(cSid, d.mesh.nodeId, dSid),
    });
    expect(info.status).toBe(200);
    expect(((await info.json()) as { node?: string }).node).toBe('d');

    const dLogin = await loginSelf(d.mesh, user);
    const back = await loginRemote(d.mesh, c.mesh, user, selfCookie(dLogin));
    expect(back.status).toBe(200);
    const cRemoteSid = sidFromResponse(back, c.mesh.nodeId);
    const infoC = await callMesh(d.mesh, `http://entry/n/${c.mesh.nodeId}/api/system/info`, {
      cookie: jarFor(dLogin, c.mesh.nodeId, cRemoteSid),
    });
    expect(infoC.status).toBe(200);

    const rtcSession = a.mesh.hub?.registerRtcSession({
      userId: user.userId,
      browserSessionId: 'g5',
      fromNodeId: c.mesh.nodeId,
      toNodeId: d.mesh.nodeId,
    });
    expect(rtcSession).toBeTruthy();
    const dSignals: string[] = [];
    const cSignals: string[] = [];
    d.mesh.uplink.liveClient()?.link?.ctl.onMessage((bytes) => {
      try {
        const msg = decodeUplinkCtl(bytes);
        if (msg.t === 'rtc.signal' && msg.sdp) dSignals.push(msg.sdp);
      } catch {
        /* ignore */
      }
    });
    c.mesh.uplink.liveClient()?.link?.ctl.onMessage((bytes) => {
      try {
        const msg = decodeUplinkCtl(bytes);
        if (msg.t === 'rtc.signal' && msg.sdp) cSignals.push(msg.sdp);
      } catch {
        /* ignore */
      }
    });
    c.mesh.uplink.sendCtl({
      t: 'rtc.signal',
      rtcSession: rtcSession!,
      from: 'browser',
      to: d.mesh.nodeId,
      sdp: 'g5-offer',
    });
    await waitUntil(() => dSignals.includes('g5-offer'), 8_000);
    d.mesh.uplink.sendCtl({
      t: 'rtc.signal',
      rtcSession: rtcSession!,
      from: 'node',
      to: c.mesh.nodeId,
      sdp: 'g5-answer',
    });
    await waitUntil(() => cSignals.includes('g5-answer'), 8_000);

    router.takeDown(HUB_A_URL);
    await waitUntil(() => attachedUrl(c.mesh) === HUB_B_URL, 8_000);
    await waitUntil(() => b.mesh.hub?.registry.get(c.mesh.nodeId)?.authenticated === true, 8_000);
    const after = await loginRemote(c.mesh, d.mesh, user, selfCookie(cSid));
    expect(after.status).toBe(200);
  }, 30_000);
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
