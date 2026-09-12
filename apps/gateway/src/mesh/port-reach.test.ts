import { afterEach, describe, expect, test } from 'bun:test';
import type { MeshNodeDto } from './node-list-projection';
import {
  PEER_REPORT_TTL_MS,
  ingestPeerReachMap,
  ingestTurnOk,
  isProbeablePeerEndpoint,
  membersProbeSnapshot,
  meshPortsForNode,
  notePeerServerBind,
  notePeerTransport,
  noteRtcGather,
  overlayMeshNodePorts,
  probePeerEndpoints,
  resetPortReachForTest,
  setStunOkForTest,
} from './port-reach';

const SELF = 'aa'.repeat(16);
const PEER = 'cc'.repeat(16);
const PEER_B = 'dd'.repeat(16);
const PUBLIC_EP = 'ws://203.0.113.10:39001/peer';
const PRIVATE_EP = 'ws://10.0.0.2:39001/peer';
const FAKE_EP = 'ws://198.18.0.1:39001/peer';

function portsOf(
  nodeId: string,
  extra?: { endpoints?: string[]; directFailure?: MeshNodeDto['directFailure'] }
) {
  return meshPortsForNode({
    nodeId,
    selfId: SELF,
    endpoints: extra?.endpoints,
    directFailure: extra?.directFailure,
  });
}

function signaling(
  nodeId: string,
  extra?: { endpoints?: string[]; directFailure?: MeshNodeDto['directFailure'] }
) {
  return portsOf(nodeId, extra).find((row) => row.purpose === 'peer-signaling');
}

function rtc(nodeId: string) {
  return portsOf(nodeId).find((row) => row.purpose === 'rtc-ice');
}

describe('port reach aggregation', () => {
  afterEach(() => {
    resetPortReachForTest();
  });

  test('skips private, CGNAT and fake-IP endpoints', () => {
    expect(isProbeablePeerEndpoint(PUBLIC_EP)).toBe(true);
    expect(isProbeablePeerEndpoint(PRIVATE_EP)).toBe(false);
    expect(isProbeablePeerEndpoint(FAKE_EP)).toBe(false);
    expect(isProbeablePeerEndpoint('ws://100.64.1.1:39001/peer')).toBe(false);
    expect(isProbeablePeerEndpoint('ws://192.168.1.4:39001/peer')).toBe(false);
  });

  test('peer signaling: success is open; one fail keeps previous; two fails become blocked', async () => {
    let verdict: 'ok' | 'refused' | 'timeout' = 'ok';
    resetPortReachForTest({
      probeFn: async () => ({ verdict, connectMs: verdict === 'ok' ? 90 : null }),
    });
    expect((await probePeerEndpoints(PEER, [PUBLIC_EP], { force: true })).status).toBe('open');
    expect(signaling(PEER, { endpoints: [PUBLIC_EP] })?.status).toBe('open');

    verdict = 'timeout';
    const once = await probePeerEndpoints(PEER, [PUBLIC_EP], { force: true });
    expect(once.status).toBe('open');
    expect(signaling(PEER, { endpoints: [PUBLIC_EP] })?.status).toBe('open');

    const twice = await probePeerEndpoints(PEER, [PUBLIC_EP], { force: true });
    expect(twice.status).toBe('blocked');
    expect(twice.code).toBe('peer_timeout');
    expect(signaling(PEER, { endpoints: [PUBLIC_EP] })?.code).toBe('peer_timeout');
  });

  test('peer signaling: refused code after two consecutive refusals; cadence skips', async () => {
    let now = 1_000;
    resetPortReachForTest({
      now: () => now,
      probeFn: async () => ({ verdict: 'refused', connectMs: null }),
    });
    await probePeerEndpoints(PEER, [PUBLIC_EP], { force: true });
    const first = await probePeerEndpoints(PEER, [PUBLIC_EP], { force: true });
    expect(first.status).toBe('blocked');
    expect(first.code).toBe('peer_refused');
    now += 1_000;
    const skipped = await probePeerEndpoints(PEER, [PUBLIC_EP]);
    expect(skipped.consecutiveFails).toBe(2);
  });

  test('directFailure.ws refused marks blocked; no public endpoint stays unknown', async () => {
    expect(signaling(PEER, { endpoints: [PRIVATE_EP] })?.status).toBe('unknown');
    expect(
      signaling(PEER, {
        endpoints: [PUBLIC_EP],
        directFailure: { at: 9, ws: 'refused ws://203.0.113.10:39001/peer', wsCode: 'refused' },
      })?.status
    ).toBe('blocked');
    expect(
      signaling(PEER, {
        endpoints: [PUBLIC_EP],
        directFailure: { at: 9, ws: 'refused ws://203.0.113.10:39001/peer', wsCode: 'refused' },
      })?.code
    ).toBe('peer_refused');
  });

  test('self peer-signaling: bind failure, reports, never blocked on one sample', () => {
    expect(signaling(SELF)?.status).toBe('unknown');
    ingestPeerReachMap(PEER, { [SELF.slice(0, 8)]: 'timeout' }, SELF);
    expect(signaling(SELF)?.status).toBe('unknown');
    ingestPeerReachMap(PEER_B, { [SELF.slice(0, 8)]: 'timeout' }, SELF);
    expect(signaling(SELF)?.status).toBe('blocked');
    expect(signaling(SELF)?.code).toBe('peer_timeout');
    ingestPeerReachMap(PEER, { [SELF.slice(0, 8)]: 'ok' }, SELF);
    expect(signaling(SELF)?.status).toBe('open');
    notePeerServerBind(false);
    expect(signaling(SELF)?.status).toBe('blocked');
    expect(signaling(SELF)?.code).toBe('peer_refused');
  });

  test('self peer-signaling: stale member reports expire after the TTL', () => {
    let now = 1_000;
    resetPortReachForTest({ now: () => now });
    ingestPeerReachMap(PEER, { [SELF.slice(0, 8)]: 'refused' }, SELF);
    ingestPeerReachMap(PEER_B, { [SELF.slice(0, 8)]: 'refused' }, SELF);
    expect(signaling(SELF)?.status).toBe('blocked');
    now += PEER_REPORT_TTL_MS + 1;
    expect(signaling(SELF)?.status).toBe('unknown');
  });

  test('rtc-ice self: srflx/DC open; three no-srflx gathers with STUN ok → blocked', () => {
    expect(rtc(SELF)?.status).toBe('unknown');
    noteRtcGather({ srflx: 1 });
    expect(rtc(SELF)?.status).toBe('open');
    resetPortReachForTest();
    notePeerTransport(PEER, 'dc');
    expect(rtc(SELF)?.status).toBe('open');
    expect(rtc(PEER)?.status).toBe('open');
    resetPortReachForTest();
    notePeerTransport(PEER, 'dc');
    notePeerTransport(PEER, 'ws-secure');
    expect(rtc(PEER)?.status).toBe('open');
    resetPortReachForTest();
    setStunOkForTest(true);
    noteRtcGather({ srflx: 0 });
    noteRtcGather({ srflx: 0 });
    expect(rtc(SELF)?.status).toBe('unknown');
    noteRtcGather({ srflx: 0 });
    expect(rtc(SELF)?.status).toBe('blocked');
    expect(rtc(SELF)?.code).toBe('no_srflx');
  });

  test('membersProbe counts turn_ok reports; absence is not ok', () => {
    expect(membersProbeSnapshot()).toBeNull();
    ingestTurnOk(PEER, true);
    ingestTurnOk(PEER_B, false);
    ingestTurnOk('ee'.repeat(16), undefined);
    const snap = membersProbeSnapshot();
    expect(snap?.ok).toBe(1);
    expect(snap?.total).toBe(2);
  });

  test('overlayMeshNodePorts attaches ports to every row including self', () => {
    const nodes = overlayMeshNodePorts(
      [
        {
          id: SELF,
          name: 'self',
          publicKey: 'x',
          online: true,
          reach: null,
          transport: null,
          rttMs: null,
          version: null,
          direct_capable: false,
          inventory: null,
          loggedIn: true,
          isHub: false,
        },
        {
          id: PEER,
          name: 'peer',
          publicKey: 'y',
          online: true,
          reach: 'wan',
          transport: 'dc',
          rttMs: 1,
          version: null,
          direct_capable: true,
          inventory: null,
          loggedIn: false,
          isHub: false,
          endpoints: [PUBLIC_EP],
        },
      ],
      SELF
    );
    expect(nodes[0]?.ports?.some((row) => row.purpose === 'peer-signaling')).toBe(true);
    expect(nodes[1]?.ports?.some((row) => row.purpose === 'rtc-ice')).toBe(true);
  });
});
