import { afterEach, describe, expect, test } from 'bun:test';
import { generateEd25519KeyPair } from '@vibeterm/shared/auth';
import { bootRelayMeshHarness, waitUntil } from '../../relay/integration/relay-mesh-harness';
import type { MeshRuntime } from '../mesh-runtime';
import { encodeRtcWakeSdp, peerRtcSession } from '../rtc/ice';
import { createFakeNativeModule } from '../rtc/test-fakes';

describe('rtc wake via authenticated uplink', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];
  afterEach(async () => {
    while (fixtures.length > 0) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  test('single-sided getLink from the larger id yields dc; forged wakes are rejected', async () => {
    const fake = createFakeNativeModule();
    const loadNative = async () => fake.module;

    const h = await bootRelayMeshHarness();
    fixtures.push({ close: () => {}, stop: () => h.stop() });
    const tenant = await h.createTenant('alice', {
      loadNative,
      peerPort: 39001,
      stunServers: ['stun:stun.example:3478'],
    });
    await tenant.enroll();
    const meshA = tenant.owner.mesh;
    const meshB = (
      await tenant.joinNode('node-b', {
        loadNative,
        peerPort: 39002,
        stunServers: ['stun:stun.example:3478'],
      })
    ).mesh;
    const meshC = (
      await tenant.joinNode('node-c', {
        loadNative,
        peerPort: 39003,
        stunServers: ['stun:stun.example:3478'],
      })
    ).mesh;

    await waitUntil(
      () => meshA.lastNodeList?.nodes.some((n) => n.id === meshB.nodeId && n.online) === true,
      8_000
    );
    await waitUntil(
      () => meshA.lastNodeList?.nodes.some((n) => n.id === meshC.nodeId && n.online) === true,
      8_000
    );

    const [offerer, answerer]: [MeshRuntime, MeshRuntime] =
      meshA.nodeId.toLowerCase() < meshB.nodeId.toLowerCase() ? [meshA, meshB] : [meshB, meshA];
    const rtcSession = peerRtcSession(offerer.nodeId, answerer.nodeId);
    const before = fake.connections.length;

    const sendWake = (sdp: string) => {
      answerer.uplink.sendCtl({
        t: 'rtc.signal',
        rtcSession,
        from: 'node',
        to: offerer.nodeId,
        sdp,
      });
    };

    sendWake(JSON.stringify({ type: 'rtc.wake' }));
    sendWake(
      encodeRtcWakeSdp({
        from: answerer.nodeId,
        to: offerer.nodeId,
        rtcSession,
        issuedAt: Date.now(),
        secretKey: generateEd25519KeyPair().secretKey,
      })
    );
    sendWake(
      encodeRtcWakeSdp({
        from: offerer.nodeId,
        to: answerer.nodeId,
        rtcSession,
        issuedAt: Date.now(),
        secretKey: answerer.identity.edPrivateKey,
      })
    );
    expect(meshC.uplink.state).toBe('online');
    // hub 时代由 hub 丢弃发往已吊销节点的 rtc.signal；中继只转发。
    // 接收侧 isTrusted(from) / 对端 dial 前的 admit 检查依赖本地 cert 视图。
    meshA.userStore.markCertRevoked(meshC.nodeId, 99);
    answerer.userStore.markCertRevoked(meshC.nodeId, 99);
    meshC.userStore.markCertRevoked(answerer.nodeId, 99);
    expect(meshC.uplink.state).toBe('online');
    answerer.uplink.sendCtl({
      t: 'rtc.signal',
      rtcSession: peerRtcSession(answerer.nodeId, meshC.nodeId),
      from: 'node',
      to: meshC.nodeId,
      sdp: encodeRtcWakeSdp({
        from: answerer.nodeId,
        to: meshC.nodeId,
        rtcSession: peerRtcSession(answerer.nodeId, meshC.nodeId),
        issuedAt: Date.now(),
        secretKey: answerer.identity.edPrivateKey,
      }),
    });
    await Bun.sleep(80);
    expect(fake.connections.length).toBe(before);
    expect(offerer.peers.transportOf(answerer.nodeId)).toBeNull();
    expect(answerer.peers.transportOf(offerer.nodeId)).toBeNull();

    await answerer.peers.getLink(offerer.nodeId);
    await waitUntil(() => answerer.peers.transportOf(offerer.nodeId) === 'dc', 8_000);
    await waitUntil(() => offerer.peers.transportOf(answerer.nodeId) === 'dc', 8_000);
    expect(answerer.peers.transportOf(offerer.nodeId)).toBe('dc');
    expect(offerer.peers.transportOf(answerer.nodeId)).toBe('dc');
    expect(fake.connections.length).toBeGreaterThan(before);
  }, 20_000);
});
