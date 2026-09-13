import { describe, expect, test } from 'bun:test';
import { RELAY_PRESENCE_STALE_MS, RelayPresence } from './relay-presence';

const SH = 'https://sh.example';
const TK = 'https://tk.example';
const PEER_A = 'aa'.repeat(16);
const PEER_B = 'bb'.repeat(16);
const PEER_C = 'cc'.repeat(16);

function seedTwo(p: RelayPresence, now = 1_000): void {
  p.setPriority(SH, 0);
  p.setPriority(TK, 1);
  p.setPrimary(SH);
  p.setConnected(SH, true, 20, now);
  p.setConnected(TK, true, 80, now);
  p.applyList(
    SH,
    [
      { id: PEER_A, online: true, rttMs: 22 },
      { id: PEER_B, online: true, rttMs: 30 },
    ],
    1,
    now
  );
  p.applyList(
    TK,
    [
      { id: PEER_A, online: true, rttMs: 70 },
      { id: PEER_C, online: true, rttMs: 12 },
    ],
    1,
    now
  );
}

describe('RelayPresence chooser', () => {
  test('argmin selfRtt+peerRtt；缺样本排在完整行之后；同分 primary 优先', () => {
    const p = new RelayPresence();
    seedTwo(p);
    expect(p.chooseRelay(PEER_A)).toEqual({ url: SH, role: 'primary', scoreMs: 42 });
    p.setSelfRtt(SH, 200);
    expect(p.chooseRelay(PEER_A)).toEqual({ url: TK, role: 'secondary', scoreMs: 150 });

    const incomplete = new RelayPresence();
    incomplete.setPriority(SH, 0);
    incomplete.setPriority(TK, 1);
    incomplete.setPrimary(SH);
    incomplete.setConnected(SH, true, null, 1);
    incomplete.setConnected(TK, true, 10, 1);
    incomplete.applyList(SH, [{ id: PEER_A, online: true, rttMs: 5 }], 1, 1);
    incomplete.applyList(TK, [{ id: PEER_A, online: true, rttMs: 5 }], 1, 1);
    expect(incomplete.chooseRelay(PEER_A)?.url).toBe(TK);
    incomplete.setSelfRtt(SH, 10);
    incomplete.applyList(SH, [{ id: PEER_A, online: true }], 2, 1);
    expect(incomplete.chooseRelay(PEER_A)?.url).toBe(TK);
    incomplete.setConnected(TK, true, null, 1);
    incomplete.applyList(TK, [{ id: PEER_A, online: true }], 2, 1);
    expect(incomplete.chooseRelay(PEER_A)).toEqual({
      url: SH,
      role: 'primary',
      scoreMs: null,
    });
  });

  test('exclude 跳过指定 URL；未连接的中继不入选', () => {
    const p = new RelayPresence();
    seedTwo(p);
    expect(p.chooseRelay(PEER_A, { exclude: [SH] })?.url).toBe(TK);
    p.setConnected(TK, false, null, 2);
    expect(p.chooseRelay(PEER_A, { exclude: [SH] })).toBeNull();
  });

  test('2.2.x 单挂载对端只出现在一台中继上', () => {
    const p = new RelayPresence();
    seedTwo(p);
    expect(p.chooseRelay(PEER_C)?.url).toBe(TK);
    expect(p.relaysFor(PEER_C)).toEqual([TK]);
    expect(p.relaysFor(PEER_A)).toEqual([SH, TK]);
  });
});

describe('RelayPresence union / staleness', () => {
  test('onlineUnion 是各中继 online 的并集', () => {
    const p = new RelayPresence();
    seedTwo(p);
    expect([...p.onlineUnion()].sort()).toEqual([PEER_A, PEER_B, PEER_C].sort());
    expect(p.peersOnlineOn(SH)).toBe(2);
    expect(p.peersOnlineOn(TK)).toBe(2);
  });

  test('掉线后 90s hold，到期只让 exclusive 对端离线', () => {
    const p = new RelayPresence();
    seedTwo(p, 1_000);
    p.markDisconnected(TK, 1_000, RELAY_PRESENCE_STALE_MS);
    expect(p.chooseRelay(PEER_C)).toBeNull();
    expect(p.onlineUnion(1_000 + 1).has(PEER_C)).toBe(true);
    expect(p.onlineUnion(1_000 + 1).has(PEER_A)).toBe(true);
    const exclusive = p.decay(TK, 1_000 + RELAY_PRESENCE_STALE_MS);
    expect(exclusive).toEqual([PEER_C]);
    expect(p.onlineUnion(1_000 + RELAY_PRESENCE_STALE_MS).has(PEER_C)).toBe(false);
    expect(p.onlineUnion(1_000 + RELAY_PRESENCE_STALE_MS).has(PEER_A)).toBe(true);
    expect(p.onlineUnion(1_000 + RELAY_PRESENCE_STALE_MS).has(PEER_B)).toBe(true);
  });

  test('applyList 后不 setConnected 仍返回该 URL 的在线计数', () => {
    const p = new RelayPresence();
    p.setPrimary(SH);
    p.applyList(
      SH,
      [
        { id: PEER_A, online: true },
        { id: PEER_B, online: true },
        { id: PEER_C, online: false },
      ],
      1,
      1
    );
    expect(p.peersOnlineOn(SH)).toBe(2);
    expect(p.peersOnlineOn(TK)).toBeNull();
  });

  test('primary 切换改 role，snapshot 里 primary 在前', () => {
    const p = new RelayPresence();
    seedTwo(p);
    p.setPrimary(TK);
    const snap = p.snapshot();
    expect(snap[0]?.url).toBe(TK);
    expect(snap[0]?.role).toBe('primary');
    expect(snap[1]?.role).toBe('secondary');
    expect(p.primaryUrl()).toBe(TK);
  });
});
