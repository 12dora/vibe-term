import { afterEach, describe, expect, test } from 'bun:test';
import type { MeshNodeDto } from './node-list-projection';
import {
  PEER_REPORT_TTL_MS,
  PORT_PROBE_CADENCE_MS,
  TURN_REPORT_TTL_MS,
  bumpSelfPeerReachEpoch,
  ingestPeerReachEpoch,
  ingestPeerReachMap,
  ingestTurnOk,
  isProbeablePeerEndpoint,
  membersProbeSnapshot,
  meshPortsForNode,
  notePeerServerBind,
  notePeerTransport,
  notePublicHttpsUplink,
  noteRtcGather,
  overlayMeshNodePorts,
  peerReachEpochPayload,
  probePeerEndpoints,
  resetPortReachForTest,
  setSelfPortRolesForTest,
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
      trust: async () => true,
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

  test('peer signaling: refused is blocked on the first hit; cadence skips', async () => {
    let now = 1_000;
    resetPortReachForTest({
      trust: async () => true,
      now: () => now,
      probeFn: async () => ({ verdict: 'refused', connectMs: null }),
    });
    const first = await probePeerEndpoints(PEER, [PUBLIC_EP], { force: true });
    expect(first.status).toBe('blocked');
    expect(first.code).toBe('peer_refused');
    now += 1_000;
    const skipped = await probePeerEndpoints(PEER, [PUBLIC_EP]);
    expect(skipped.consecutiveFails).toBe(1);
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

  test('self peer-signaling: bind failure, refused is immediate, timeout needs two', () => {
    expect(signaling(SELF)?.status).toBe('unknown');
    ingestPeerReachMap(PEER, { [SELF.slice(0, 8)]: 'timeout' }, SELF);
    expect(signaling(SELF)?.status).toBe('unknown');
    ingestPeerReachMap(PEER_B, { [SELF.slice(0, 8)]: 'timeout' }, SELF);
    expect(signaling(SELF)?.status).toBe('blocked');
    expect(signaling(SELF)?.code).toBe('peer_timeout');
    resetPortReachForTest();
    ingestPeerReachMap(PEER, { [SELF.slice(0, 8)]: 'refused' }, SELF);
    expect(signaling(SELF)?.status).toBe('blocked');
    expect(signaling(SELF)?.code).toBe('peer_refused');
    ingestPeerReachMap(PEER, { [SELF.slice(0, 8)]: 'ok' }, SELF);
    expect(signaling(SELF)?.status).toBe('open');
    notePeerServerBind(false);
    expect(signaling(SELF)?.status).toBe('blocked');
    expect(signaling(SELF)?.code).toBe('peer_refused');
  });

  test('self peer-signaling: same reporter timing out twice is blocked', () => {
    ingestPeerReachMap(PEER, { [SELF.slice(0, 8)]: 'timeout' }, SELF);
    expect(signaling(SELF)?.status).toBe('unknown');
    ingestPeerReachMap(PEER, { [SELF.slice(0, 8)]: 'timeout' }, SELF);
    expect(signaling(SELF)?.status).toBe('blocked');
    expect(signaling(SELF)?.code).toBe('peer_timeout');
  });

  test('self peer-signaling: stale member reports expire after the TTL', () => {
    let now = 1_000;
    resetPortReachForTest({
      trust: async () => true,
      now: () => now,
    });
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
    const relay = 'https://relay.example';
    expect(membersProbeSnapshot()).toBeNull();
    ingestTurnOk(PEER, true, relay);
    ingestTurnOk(PEER_B, false, relay);
    ingestTurnOk('ee'.repeat(16), undefined, relay);
    const snap = membersProbeSnapshot(relay);
    expect(snap?.ok).toBe(1);
    expect(snap?.total).toBe(2);
  });

  test('turn_ok reports are keyed by relay URL and do not overwrite across relays', () => {
    const primary = 'https://sh.example';
    const secondary = 'https://jp.example';
    ingestTurnOk(PEER, true, primary);
    ingestTurnOk(PEER, false, secondary);
    ingestTurnOk(PEER_B, true, secondary);
    expect(membersProbeSnapshot(primary)).toMatchObject({ ok: 1, total: 1 });
    expect(membersProbeSnapshot(secondary)).toMatchObject({ ok: 1, total: 2 });
    const union = membersProbeSnapshot();
    expect(union?.ok).toBe(2);
    expect(union?.total).toBe(3);
  });

  test('membersProbe drops reports older than the TTL and can exclude self', () => {
    let now = 1_000;
    resetPortReachForTest({ now: () => now });
    const relay = 'https://relay.example';
    ingestTurnOk(SELF, true, relay);
    ingestTurnOk(PEER, false, relay);
    expect(membersProbeSnapshot(relay, { excludeId: SELF })).toMatchObject({ ok: 0, total: 1 });
    now += TURN_REPORT_TTL_MS + 1;
    expect(membersProbeSnapshot(relay)).toBeNull();
  });

  test('canonical relay URL forms share a bucket', () => {
    ingestTurnOk(PEER, true, 'https://Relay.Example/');
    expect(membersProbeSnapshot('https://relay.example')).toMatchObject({ ok: 1, total: 1 });
  });

  test('peer_reach_epoch bump is advertised and resets cadence for that peer', async () => {
    let now = 1_000;
    let probes = 0;
    resetPortReachForTest({
      now: () => now,
      probeFn: async () => {
        probes += 1;
        return { verdict: 'ok', connectMs: 10 };
      },
    });
    expect(peerReachEpochPayload()).toBeUndefined();
    expect(bumpSelfPeerReachEpoch()).toBe(1);
    expect(peerReachEpochPayload()).toBe(1);
    await probePeerEndpoints(PEER, [PUBLIC_EP], { force: true });
    expect(probes).toBe(3);
    now += 1_000;
    await probePeerEndpoints(PEER, [PUBLIC_EP]);
    expect(probes).toBe(3);
    ingestPeerReachEpoch(PEER, 1);
    await probePeerEndpoints(PEER, [PUBLIC_EP]);
    expect(probes).toBe(6);
    ingestPeerReachEpoch(PEER, 1);
    now += PORT_PROBE_CADENCE_MS + 1;
    await probePeerEndpoints(PEER, [PUBLIC_EP]);
    expect(probes).toBe(9);
  });

  test('self derived public-https is open when a member is uplinked', () => {
    setSelfPortRolesForTest({ hub: true, relay: false });
    expect(portsOf(SELF).find((row) => row.purpose === 'public-https')?.status).toBe('unknown');
    notePublicHttpsUplink(true);
    expect(portsOf(SELF).find((row) => row.purpose === 'public-https')?.status).toBe('open');
    expect(portsOf(PEER).some((row) => row.purpose === 'public-https')).toBe(false);
  });

  test('self derived TURN rows follow membersProbeSnapshot; relay range is not_probed', () => {
    setSelfPortRolesForTest({ hub: false, relay: true });
    const relay = 'https://relay.example';
    ingestTurnOk(PEER, false, relay);
    expect(portsOf(SELF).find((row) => row.purpose === 'turn-control')?.status).toBe('unknown');
    ingestTurnOk(PEER_B, false, relay);
    const control = portsOf(SELF).find((row) => row.purpose === 'turn-control');
    expect(control?.status).toBe('blocked');
    expect(control?.code).toBe('turn_probe_failed');
    const range = portsOf(SELF).find((row) => row.purpose === 'turn-relay');
    expect(range?.status).toBe('blocked');
    expect(range?.code).toBe('turn_probe_failed');
    ingestTurnOk(PEER, true, relay);
    const openControl = portsOf(SELF).find((row) => row.purpose === 'turn-control');
    expect(openControl?.status).toBe('open');
    const openRange = portsOf(SELF).find((row) => row.purpose === 'turn-relay');
    expect(openRange?.status).toBe('open');
    expect(openRange?.code).toBe('not_probed');
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
