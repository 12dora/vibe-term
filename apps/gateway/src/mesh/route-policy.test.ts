import { describe, expect, test } from 'bun:test';
import { PeerPathRttMemory } from './peer-path-rtt';
import type { RelayPresenceIndex } from './relay-presence-types';
import {
  type RoutePolicySnapshot,
  decidePath,
  directSlowThresholdMs,
  estimateRelayMs,
  isDirectSlowVsRelay,
  isDirectTransport,
  nextPromoteBackoffMs,
  pathKindOf,
  promoteMarginMs,
  readDirectMs,
  relayClearlyBetterForBulk,
  relayMsForPeer,
  shouldPromoteDirect,
} from './route-policy';

const BASE: RoutePolicySnapshot = {
  mode: 'auto',
  streamClass: 'interactive',
  liveKind: 'direct',
  directMs: 20,
  relayMs: 15,
  degraded: false,
  backoffActive: false,
};

function snap(patch: Partial<RoutePolicySnapshot> = {}): RoutePolicySnapshot {
  return { ...BASE, ...patch };
}

describe('route-policy thresholds', () => {
  test('degrade: 小 RTT 用 +40ms，大 RTT 用 1.5×', () => {
    expect(directSlowThresholdMs(15)).toBe(55);
    expect(directSlowThresholdMs(100)).toBe(150);
    expect(isDirectSlowVsRelay(56, 15)).toBe(true);
    expect(isDirectSlowVsRelay(55, 15)).toBe(false);
    expect(isDirectSlowVsRelay(225, 15)).toBe(true);
    expect(isDirectSlowVsRelay(50, 15)).toBe(false);
  });

  test('promote: RTT < relayMs − max(5, 20%)；15 ms 中继下局域网直连仍能升回', () => {
    expect(promoteMarginMs(15)).toBe(5);
    expect(promoteMarginMs(200)).toBe(40);
    expect(shouldPromoteDirect(50, 100)).toBe(true);
    expect(shouldPromoteDirect(80, 100)).toBe(false);
    expect(shouldPromoteDirect(90, 100)).toBe(false);
    expect(shouldPromoteDirect(2, 15)).toBe(true);
    expect(shouldPromoteDirect(10, 15)).toBe(false);
    expect(shouldPromoteDirect(12, 15)).toBe(false);
  });

  test('backoff 2 min 起步翻倍封顶 30 min', () => {
    expect(nextPromoteBackoffMs(null)).toBe(120_000);
    expect(nextPromoteBackoffMs(0)).toBe(120_000);
    expect(nextPromoteBackoffMs(120_000)).toBe(240_000);
    expect(nextPromoteBackoffMs(16 * 60 * 1000)).toBe(30 * 60 * 1000);
    expect(nextPromoteBackoffMs(30 * 60 * 1000)).toBe(30 * 60 * 1000);
  });

  test('bulk 预留门槛：中继必须同时好出 40 ms 与 20%', () => {
    expect(relayClearlyBetterForBulk(200, 15)).toBe(true);
    expect(relayClearlyBetterForBulk(50, 40)).toBe(false);
    expect(relayClearlyBetterForBulk(100, 80)).toBe(false);
    expect(relayClearlyBetterForBulk(80, 80)).toBe(false);
  });
});

describe('decidePath 三模式表', () => {
  test('direct 模式永远报 direct（不可达时由拨号层掉 relay）', () => {
    expect(decidePath('p', 'interactive', snap({ mode: 'direct', liveKind: null }))).toBe('direct');
    expect(
      decidePath('p', 'interactive', snap({ mode: 'direct', liveKind: 'relay', degraded: true }))
    ).toBe('direct');
    expect(decidePath('p', 'bulk', snap({ mode: 'direct', directMs: 500, relayMs: 15 }))).toBe(
      'direct'
    );
  });

  test('relay 模式永远报 relay', () => {
    expect(decidePath('p', 'interactive', snap({ mode: 'relay', liveKind: 'direct' }))).toBe(
      'relay'
    );
    expect(decidePath('p', 'bulk', snap({ mode: 'relay', liveKind: null, directMs: 10 }))).toBe(
      'relay'
    );
  });

  test('auto 起步像 direct；live 直连未过门槛不降', () => {
    expect(decidePath('p', 'interactive', snap({ liveKind: null }))).toBe('direct');
    expect(decidePath('p', 'interactive', snap({ directMs: 20, relayMs: 15 }))).toBe('direct');
    expect(decidePath('p', 'interactive', snap({ directMs: 50, relayMs: 15 }))).toBe('direct');
  });

  test('auto：直连慢于 max(relay+40, 1.5×) 时报 relay', () => {
    expect(decidePath('p', 'interactive', snap({ directMs: 225, relayMs: 15 }))).toBe('relay');
    expect(decidePath('p', 'interactive', snap({ directMs: 56, relayMs: 15 }))).toBe('relay');
  });

  test('auto：降级或回退中强制 relay', () => {
    expect(decidePath('p', 'interactive', snap({ degraded: true, directMs: 10 }))).toBe('relay');
    expect(decidePath('p', 'interactive', snap({ backoffActive: true, liveKind: 'relay' }))).toBe(
      'relay'
    );
  });

  test('auto + bulk：无双 live 时仍按预留门槛编码偏好', () => {
    expect(decidePath('p', 'bulk', snap({ liveKind: null, directMs: 200, relayMs: 15 }))).toBe(
      'relay'
    );
    expect(decidePath('p', 'bulk', snap({ liveKind: 'relay', directMs: 40, relayMs: 30 }))).toBe(
      'direct'
    );
    expect(
      decidePath('p', 'interactive', snap({ liveKind: 'relay', directMs: 40, relayMs: 30 }))
    ).toBe('relay');
  });
});

describe('readDirectMs / estimateRelayMs', () => {
  test('live 是 dc/ws-secure 用 live.rttMs，否则取窗口内最佳直连样本', () => {
    const pathRtt = new PeerPathRttMemory({ now: () => 1_000 });
    pathRtt.record('p', { kind: 'dc', rttMs: 40 });
    expect(readDirectMs({ liveTransport: 'dc', liveRttMs: 225, peerId: 'p', pathRtt })).toBe(225);
    expect(readDirectMs({ liveTransport: 'relay', liveRttMs: 15, peerId: 'p', pathRtt })).toBe(40);
    expect(
      readDirectMs({ liveTransport: 'relay', liveRttMs: 15, peerId: 'nobody', pathRtt })
    ).toBeNull();
  });

  test('relay 估计：live 是 relay 用 live；否则 score，否则 self+peer，否则 2×self', () => {
    expect(
      estimateRelayMs({
        liveIsRelay: true,
        liveRttMs: 18,
        selfUplinkMs: 14,
        peerUplinkMs: 1,
        chooseScoreMs: 15,
      })
    ).toBe(18);
    expect(
      estimateRelayMs({
        liveIsRelay: false,
        liveRttMs: 225,
        selfUplinkMs: 14,
        peerUplinkMs: 1,
        chooseScoreMs: 15,
      })
    ).toBe(15);
    expect(
      estimateRelayMs({
        liveIsRelay: false,
        liveRttMs: null,
        selfUplinkMs: 14,
        peerUplinkMs: 1,
        chooseScoreMs: null,
      })
    ).toBe(15);
    expect(
      estimateRelayMs({
        liveIsRelay: false,
        liveRttMs: null,
        selfUplinkMs: 14,
        peerUplinkMs: null,
        chooseScoreMs: null,
      })
    ).toBe(28);
    expect(
      estimateRelayMs({
        liveIsRelay: false,
        liveRttMs: null,
        selfUplinkMs: null,
        peerUplinkMs: null,
        chooseScoreMs: null,
      })
    ).toBeNull();
  });

  test('presence roster 提供对端上行 RTT 与 chooseRelay.scoreMs', () => {
    const presence = {
      chooseRelay: (id: string) =>
        id === 'p' ? { url: 'https://r', role: 'primary' as const, scoreMs: 15 } : null,
      snapshot: () => [
        {
          url: 'https://r',
          role: 'primary' as const,
          connected: true,
          selfRttMs: 14,
          peers: new Map([['p', { online: true, rttMs: 1, seenAt: 1 }]]),
          listVersion: 1,
          updatedAt: 1,
        },
      ],
    } as unknown as RelayPresenceIndex;
    expect(
      relayMsForPeer({
        liveTransport: 'dc',
        liveRttMs: 225,
        peerId: 'p',
        selfUplinkMs: 14,
        presence,
      })
    ).toBe(15);
  });

  test('isDirectTransport / pathKindOf', () => {
    expect(isDirectTransport('dc')).toBe(true);
    expect(isDirectTransport('ws-secure')).toBe(true);
    expect(isDirectTransport('relay')).toBe(false);
    expect(pathKindOf('dc')).toBe('direct');
    expect(pathKindOf('relay')).toBe('relay');
  });
});
