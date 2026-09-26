import { afterEach, describe, expect, test } from 'bun:test';
import { buildRtcIceConfig, hasTurnServer } from './ice';
import {
  ICE_GAIN_DEBOUNCE_MS,
  bindIceConfigRearm,
  gateTurnByProbe,
  meshRtcConfigResponse,
  resetIceConfigRearmForTests,
  resetTurnGateLogForTest,
  resolveMeshRtcConfig,
} from './stun-effective';
import { resetTurnProbeForTest, setTurnProbeSnapshotForTest } from './turn-probe';

afterEach(() => {
  resetTurnProbeForTest();
  resetTurnGateLogForTest();
  resetIceConfigRearmForTests();
});

const local = {
  stunServers: ['stun:a.example:3478'],
  stunSource: 'custom' as const,
  turnUrl: 'turn:relay.example:3478',
  turnUsername: 'u',
  turnCredential: 'p',
};

const configured = {
  url: 'turn:relay.example:3478',
  username: 'u',
  credential: 'p',
};

const runtime = { peerBindHost: ['::', '0.0.0.0'] as const, rtcPortRange: null };

const a = { url: 'turn:a.example:3478', username: 'ua', credential: 'pa' };
const b = { url: 'turn:b.example:3478', username: 'ub', credential: 'pb' };
const c = { url: 'turn:c.example:3478', username: 'uc', credential: 'pc' };

describe('gateTurnByProbe / resolveMeshRtcConfig', () => {
  test('never probed ⇒ TURN out, mux on', () => {
    const resolved = resolveMeshRtcConfig(local, null);
    expect(resolved.turn).toEqual([]);
    expect(resolved.turnConfigured).toEqual([configured]);
    expect(resolved.turnProbeOk).toBe(false);
    const ice = buildRtcIceConfig(resolved, runtime);
    expect(hasTurnServer(ice.iceServers)).toBe(false);
    expect(ice.enableIceUdpMux).toBe(true);
  });

  test('probe ok ⇒ TURN in, mux off', () => {
    setTurnProbeSnapshotForTest([
      { url: 'turn:relay.example:3478', ok: true, rttMs: 12, probedAt: 1 },
    ]);
    const resolved = resolveMeshRtcConfig(local, null);
    expect(resolved.turn).toEqual([configured]);
    expect(resolved.turnConfigured).toEqual([configured]);
    expect(resolved.turnProbeOk).toBe(true);
    const ice = buildRtcIceConfig(resolved, runtime);
    expect(hasTurnServer(ice.iceServers)).toBe(true);
    expect(ice.enableIceUdpMux).toBe(false);
  });

  test('probe failed ⇒ TURN out, mux on', () => {
    setTurnProbeSnapshotForTest([
      {
        url: 'turn:relay.example:3478',
        ok: false,
        rttMs: 2000,
        error: 'timeout',
        probedAt: 1,
      },
    ]);
    const resolved = resolveMeshRtcConfig(local, null);
    expect(resolved.turn).toEqual([]);
    expect(resolved.turnConfigured).toEqual([configured]);
    expect(resolved.turnProbeOk).toBe(false);
    const ice = buildRtcIceConfig(resolved, runtime);
    expect(hasTurnServer(ice.iceServers)).toBe(false);
    expect(ice.enableIceUdpMux).toBe(true);
  });

  test('ignores a probe for a different TURN URL (treat as unprobed, exclude)', () => {
    setTurnProbeSnapshotForTest([
      { url: 'turn:other.example:3478', ok: true, rttMs: 1, probedAt: 1 },
    ]);
    expect(gateTurnByProbe(configured)).toEqual({ turn: [], turnProbeOk: false });
  });

  test('gates per URL, orders by RTT, and caps at 2', () => {
    setTurnProbeSnapshotForTest([
      { url: a.url, ok: true, rttMs: 40, probedAt: 1 },
      { url: b.url, ok: true, rttMs: 10, probedAt: 1 },
      { url: c.url, ok: true, rttMs: 20, probedAt: 1 },
    ]);
    const gated = gateTurnByProbe([a, b, c]);
    expect(gated.turn).toEqual([b, c]);
    expect(gated.turnProbeOk).toBe(true);
  });

  test('excludes failed and unprobed URLs independently', () => {
    setTurnProbeSnapshotForTest([
      { url: a.url, ok: false, rttMs: 2000, error: 'timeout', probedAt: 1 },
      { url: b.url, ok: true, rttMs: 15, probedAt: 1 },
    ]);
    expect(gateTurnByProbe([a, b, c])).toEqual({ turn: [b], turnProbeOk: true });
  });

  test('flattens a single object and lastRtc arrays into turnConfigured', () => {
    setTurnProbeSnapshotForTest([{ url: a.url, ok: true, rttMs: 5, probedAt: 1 }]);
    const resolved = resolveMeshRtcConfig(local, { stun: [], turn: [a, b] });
    expect(resolved.turnConfigured).toEqual([a, b]);
    expect(resolved.turn).toEqual([a]);
    expect(resolved.turnProbeOk).toBe(true);
    expect(resolved.turnProbes.map((row) => row.url)).toEqual([a.url]);
  });

  test('production provider shape: resolveMeshRtcConfig → buildRtcIceConfig excludes failed TURN', () => {
    setTurnProbeSnapshotForTest([
      { url: a.url, ok: false, rttMs: 2000, probedAt: 1 },
      { url: b.url, ok: true, rttMs: 10, probedAt: 1 },
      { url: c.url, ok: true, rttMs: 20, probedAt: 1 },
    ]);
    const iceConfigProvider = () => resolveMeshRtcConfig(local, { stun: [], turn: [a, b, c] });
    const resolved = iceConfigProvider();
    expect(resolved.turnProbes).toHaveLength(3);
    const ice = buildRtcIceConfig(resolved, runtime);
    expect(ice.iceServers).toEqual([
      'stun:a.example:3478',
      { hostname: 'b.example', port: 3478, username: 'ub', password: 'pb', relayType: 'TurnUdp' },
      { hostname: 'c.example', port: 3478, username: 'uc', password: 'pc', relayType: 'TurnUdp' },
    ]);
    expect(ice.enableIceUdpMux).toBe(false);
  });

  test('meshRtcConfigResponse exposes arrays plus compat turnProbe', () => {
    setTurnProbeSnapshotForTest([
      {
        url: 'turn:relay.example:3478',
        ok: false,
        rttMs: 2000,
        error: 'timeout',
        probedAt: 9,
      },
    ]);
    const body = meshRtcConfigResponse(local, null);
    expect(body.turn).toEqual([]);
    expect(body.turnConfigured).toEqual([configured]);
    expect(body.turnProbe).toMatchObject({
      url: 'turn:relay.example:3478',
      ok: false,
      error: 'timeout',
    });
    expect(body.turnProbes).toHaveLength(1);
    expect(body.turnProbes[0]).toMatchObject({
      url: 'turn:relay.example:3478',
      ok: false,
      error: 'timeout',
    });
    expect(body.stun).toEqual(['stun:a.example:3478']);
  });

  test('meshRtcConfigResponse turnProbe is the first configured URL record', () => {
    setTurnProbeSnapshotForTest([
      { url: b.url, ok: true, rttMs: 3, probedAt: 2 },
      { url: a.url, ok: true, rttMs: 9, probedAt: 2 },
    ]);
    const body = meshRtcConfigResponse(local, { stun: [], turn: [a, b] });
    expect(body.turnConfigured).toEqual([a, b]);
    expect(body.turn.map((row) => row.url)).toEqual([b.url, a.url]);
    expect(body.turnProbe).toMatchObject({ url: a.url, ok: true, rttMs: 9 });
    expect(body.turnProbes.map((row) => row.url)).toEqual([a.url, b.url]);
  });

  test('logs turn gate when the used set changes', () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (line?: unknown) => {
      logs.push(String(line));
    };
    try {
      setTurnProbeSnapshotForTest([{ url: a.url, ok: true, rttMs: 8, probedAt: 1 }]);
      gateTurnByProbe([a, b]);
      gateTurnByProbe([a, b]);
      setTurnProbeSnapshotForTest([
        { url: a.url, ok: true, rttMs: 8, probedAt: 1 },
        { url: b.url, ok: true, rttMs: 4, probedAt: 1 },
      ]);
      gateTurnByProbe([a, b]);
    } finally {
      console.log = origLog;
    }
    const gateLogs = logs.filter((line) => line.includes('turn gate'));
    expect(gateLogs).toHaveLength(2);
    expect(gateLogs[0]).toContain('configured=2');
    expect(gateLogs[0]).toContain('reachable=1');
    expect(gateLogs[0]).toContain(`used=[${a.url}]`);
    expect(gateLogs[1]).toContain('reachable=2');
    expect(gateLogs[1]).toContain(`used=[${b.url},${a.url}]`);
  });

  test('a new reachable TURN rearms only after it stays up for 10 min', () => {
    resetIceConfigRearmForTests();
    let rearms = 0;
    bindIceConfigRearm(() => {
      rearms += 1;
    });
    const t0 = 1_000_000;
    resolveMeshRtcConfig(local, { stun: [], turn: [a] }, undefined, t0);
    expect(rearms).toBe(0);
    setTurnProbeSnapshotForTest([{ url: a.url, ok: true, rttMs: 9, probedAt: 1 }]);
    resolveMeshRtcConfig(local, { stun: [], turn: [a] }, undefined, t0);
    expect(rearms).toBe(0);
    resolveMeshRtcConfig(local, { stun: [], turn: [a] }, undefined, t0 + ICE_GAIN_DEBOUNCE_MS - 1);
    expect(rearms).toBe(0);
    resolveMeshRtcConfig(local, { stun: [], turn: [a] }, undefined, t0 + ICE_GAIN_DEBOUNCE_MS);
    expect(rearms).toBe(1);
    resolveMeshRtcConfig(local, { stun: [], turn: [a] }, undefined, t0 + ICE_GAIN_DEBOUNCE_MS * 2);
    expect(rearms).toBe(1);
  });

  test('a TURN flap or RTT reorder does not rearm', () => {
    resetIceConfigRearmForTests();
    let rearms = 0;
    bindIceConfigRearm(() => {
      rearms += 1;
    });
    const t0 = 2_000_000;
    setTurnProbeSnapshotForTest([
      { url: a.url, ok: true, rttMs: 30, probedAt: 1 },
      { url: b.url, ok: true, rttMs: 20, probedAt: 1 },
      { url: c.url, ok: true, rttMs: 10, probedAt: 1 },
    ]);
    resolveMeshRtcConfig(local, { stun: [], turn: [a, b, c] }, undefined, t0);
    expect(rearms).toBe(0);
    setTurnProbeSnapshotForTest([
      { url: a.url, ok: true, rttMs: 5, probedAt: 2 },
      { url: b.url, ok: true, rttMs: 40, probedAt: 2 },
      { url: c.url, ok: true, rttMs: 15, probedAt: 2 },
    ]);
    resolveMeshRtcConfig(
      local,
      { stun: [], turn: [a, b, c] },
      undefined,
      t0 + ICE_GAIN_DEBOUNCE_MS
    );
    expect(rearms).toBe(0);

    resetIceConfigRearmForTests();
    rearms = 0;
    bindIceConfigRearm(() => {
      rearms += 1;
    });
    setTurnProbeSnapshotForTest([{ url: a.url, ok: true, rttMs: 9, probedAt: 1 }]);
    resolveMeshRtcConfig(local, { stun: [], turn: [a, b] }, undefined, t0);
    setTurnProbeSnapshotForTest([
      { url: a.url, ok: true, rttMs: 9, probedAt: 2 },
      { url: b.url, ok: true, rttMs: 12, probedAt: 2 },
    ]);
    resolveMeshRtcConfig(local, { stun: [], turn: [a, b] }, undefined, t0 + 1_000);
    setTurnProbeSnapshotForTest([{ url: a.url, ok: true, rttMs: 9, probedAt: 3 }]);
    resolveMeshRtcConfig(local, { stun: [], turn: [a, b] }, undefined, t0 + 2_000);
    setTurnProbeSnapshotForTest([
      { url: a.url, ok: true, rttMs: 9, probedAt: 4 },
      { url: b.url, ok: true, rttMs: 12, probedAt: 4 },
    ]);
    const back = t0 + 3_000;
    resolveMeshRtcConfig(local, { stun: [], turn: [a, b] }, undefined, back);
    resolveMeshRtcConfig(
      local,
      { stun: [], turn: [a, b] },
      undefined,
      back + ICE_GAIN_DEBOUNCE_MS - 1
    );
    expect(rearms).toBe(0);
    resolveMeshRtcConfig(local, { stun: [], turn: [a, b] }, undefined, back + ICE_GAIN_DEBOUNCE_MS);
    expect(rearms).toBe(1);
  });

  test('a STUN or configured TURN change rearms immediately', () => {
    resetIceConfigRearmForTests();
    let rearms = 0;
    bindIceConfigRearm(() => {
      rearms += 1;
    });
    const t0 = 3_000_000;
    resolveMeshRtcConfig(local, { stun: [], turn: [a] }, undefined, t0);
    expect(rearms).toBe(0);
    resolveMeshRtcConfig(
      { ...local, stunServers: ['stun:b.example:3478'] },
      { stun: [], turn: [a] },
      undefined,
      t0
    );
    expect(rearms).toBe(1);
    resolveMeshRtcConfig(local, { stun: [], turn: [a, b] }, undefined, t0);
    expect(rearms).toBe(2);
  });
});
