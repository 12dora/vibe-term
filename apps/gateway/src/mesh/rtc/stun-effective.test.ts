import { afterEach, describe, expect, test } from 'bun:test';
import { buildRtcIceConfig, hasTurnServer } from './ice';
import { gateTurnByProbe, meshRtcConfigResponse, resolveMeshRtcConfig } from './stun-effective';
import { resetTurnProbeForTest, setTurnProbeSnapshotForTest } from './turn-probe';

afterEach(() => {
  resetTurnProbeForTest();
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

describe('gateTurnByProbe / resolveMeshRtcConfig', () => {
  test('never probed ⇒ TURN in, mux on', () => {
    const resolved = resolveMeshRtcConfig(local, null);
    expect(resolved.turn).toEqual(configured);
    expect(resolved.turnConfigured).toEqual(configured);
    expect(resolved.turnProbeOk).toBe(false);
    const ice = buildRtcIceConfig(resolved, runtime);
    expect(hasTurnServer(ice.iceServers)).toBe(true);
    expect(ice.enableIceUdpMux).toBe(true);
  });

  test('probe ok ⇒ TURN in, mux off', () => {
    setTurnProbeSnapshotForTest([
      { url: 'turn:relay.example:3478', ok: true, rttMs: 12, probedAt: 1 },
    ]);
    const resolved = resolveMeshRtcConfig(local, null);
    expect(resolved.turn).toEqual(configured);
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
    expect(resolved.turn).toBeNull();
    expect(resolved.turnConfigured).toEqual(configured);
    expect(resolved.turnProbeOk).toBe(false);
    const ice = buildRtcIceConfig(resolved, runtime);
    expect(hasTurnServer(ice.iceServers)).toBe(false);
    expect(ice.enableIceUdpMux).toBe(true);
  });

  test('ignores a probe for a different TURN URL (treat as never probed)', () => {
    setTurnProbeSnapshotForTest([
      { url: 'turn:other.example:3478', ok: true, rttMs: 1, probedAt: 1 },
    ]);
    expect(gateTurnByProbe(configured)).toEqual({ turn: configured, turnProbeOk: false });
  });

  test('meshRtcConfigResponse exposes effective turn, turnConfigured and turnProbe', () => {
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
    expect(body.turn).toBeNull();
    expect(body.turnConfigured).toEqual(configured);
    expect(body.turnProbe).toMatchObject({
      url: 'turn:relay.example:3478',
      ok: false,
      error: 'timeout',
    });
    expect(body.stun).toEqual(['stun:a.example:3478']);
  });
});
