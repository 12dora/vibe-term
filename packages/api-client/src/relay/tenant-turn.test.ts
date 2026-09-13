import { describe, expect, test } from 'bun:test';
import { normalizeRelayTurn } from './tenant-turn';

describe('normalizeRelayTurn', () => {
  test('缺 url 或非法 members 时降级', () => {
    expect(normalizeRelayTurn(null)).toBeNull();
    expect(normalizeRelayTurn({ url: '', probeOk: true })).toBeNull();
    expect(
      normalizeRelayTurn({
        url: 'turn:a:3478',
        probeOk: false,
        members: { ok: -1, total: 2, updatedAt: 1 },
        localHint: 'tun',
      })
    ).toEqual({ url: 'turn:a:3478', probeOk: false, localHint: 'tun' });
  });
});
