import { describe, expect, test } from 'bun:test';
import {
  HUB_RELAY_KIND,
  HUB_RELAY_MAX_HOP,
  type HubRelayOpen,
  encodeHubRelayOpen,
  parseHubRelayOpen,
  validateHubRelay,
} from './hub-relay';

const HUB_A = 'aa'.repeat(16);
const HUB_B = 'bb'.repeat(16);
const HUB_C = 'cc'.repeat(16);
const NODE_C = '11'.repeat(16);
const NODE_D = '22'.repeat(16);

describe('hub-relay open payload', () => {
  test('往返', () => {
    const open: HubRelayOpen = {
      kind: HUB_RELAY_KIND,
      to: NODE_D,
      from: NODE_C,
      originHubId: HUB_A,
      visitedHubIds: [HUB_A],
      hop: 1,
    };
    expect(parseHubRelayOpen(encodeHubRelayOpen(open))).toEqual(open);
  });

  test('普通 relay OPEN 不是 hub-relay', () => {
    expect(
      parseHubRelayOpen(new TextEncoder().encode(JSON.stringify({ to: NODE_D, from: NODE_C })))
    ).toBeNull();
  });
});

describe('hub-relay validation matrix', () => {
  const base = {
    to: NODE_D,
    from: NODE_C,
    originHubId: HUB_A,
    visitedHubIds: [HUB_A],
    hop: 1,
    peerHubId: HUB_A,
    isAuthorizedHub: (id: string) => id === HUB_A || id === HUB_B,
    targetLocal: true,
    sameUser: true,
    sourceRevoked: false,
    targetKnown: true,
  };

  test('合法一跳通过', () => {
    expect(validateHubRelay(base)).toEqual({ ok: true });
  });

  test('未授权 origin / peer 拒绝', () => {
    expect(validateHubRelay({ ...base, isAuthorizedHub: () => false })).toEqual({
      ok: false,
      reason: 'unauthorized',
    });
    expect(validateHubRelay({ ...base, peerHubId: HUB_C })).toEqual({
      ok: false,
      reason: 'unauthorized',
    });
  });

  test('hop 超限拒绝', () => {
    expect(
      validateHubRelay({
        ...base,
        hop: HUB_RELAY_MAX_HOP + 1,
        visitedHubIds: [HUB_A, HUB_B, HUB_C],
      })
    ).toEqual({ ok: false, reason: 'hop' });
  });

  test('visited 重复拒绝', () => {
    expect(validateHubRelay({ ...base, visitedHubIds: [HUB_A, HUB_A], hop: 2 })).toEqual({
      ok: false,
      reason: 'loop',
    });
    expect(
      validateHubRelay({ ...base, visitedHubIds: [HUB_A, HUB_B], hop: 2, peerHubId: HUB_B })
    ).toEqual({ ok: true });
  });

  test('源证书吊销 / 未知目标 / 跨用户 / 目标不在本地', () => {
    expect(validateHubRelay({ ...base, sourceRevoked: true })).toEqual({
      ok: false,
      reason: 'revoked',
    });
    expect(validateHubRelay({ ...base, targetKnown: false })).toEqual({
      ok: false,
      reason: 'unknown-target',
    });
    expect(validateHubRelay({ ...base, sameUser: false })).toEqual({
      ok: false,
      reason: 'cross-user',
    });
    expect(validateHubRelay({ ...base, targetLocal: false })).toEqual({
      ok: false,
      reason: 'offline',
    });
  });
});
